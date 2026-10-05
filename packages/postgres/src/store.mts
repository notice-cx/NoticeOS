// THE ONE WAY THE WORKERS AND THE SCRIPTS REACH THE POSTGRES STORE (bead
// ro-ujb9.76.18, under D25's storage move and D27's customer separation in
// config/decisions.md). The migration runner is not a caller: it keeps its own
// administrative connection, and this module never runs a migration.
//
// THE DRIVER is node-postgres (`pg`), pinned exactly in this package:
//   - Cloudflare names it the recommended driver for Workers behind Hyperdrive
//     (it needs the `nodejs_compat` flag; Hyperdrive's floor is 8.16.3).
//   - Its surface is SQL text plus a list of parameters: the shape the D1 code
//     being ported already has (`prepare(sql).bind(...)`), and one a Node script
//     uses unchanged.
//   - Result parsing is replaceable per query (`types`), so every exactness rule
//     below lives in one function here and no process-wide setting changes.
//   Postgres.js was the alternative. The comparison and the prior art are in
//   docs/briefs/2026-09-24-postgres-driver.md.
//
// EVERY TRANSACTION NAMES ONE WORKSPACE. `inWorkspace(workspaceId, work)` sends
// BEGIN and, in the same round trip, sets the workspace with
// set_config('noticeos.workspace_id', id, true) — SET LOCAL — plus UTC, ISO
// dates, shortest-exact floats and hex bytea, and reads back who the connection
// is. It refuses to go on unless the connection is the application role itself
// (noticeos_app: owns nothing, bypasses no row security). Then `work` runs its
// statements — one at a time, in the order it calls them, all finished before
// anything else — and the transaction commits. A failed statement, an error `work`
// throws, or a failure `work` caught and swallowed rolls the whole transaction
// back and throws. The settings are LOCAL, so they end with the transaction: a
// connection Hyperdrive's transaction pooling hands to the next request carries
// no workspace, and forced row security shows a transaction without one no rows
// and refuses its writes. There is no way to open one without a workspace.
//
// WHERE THE WORKSPACE ID COMES FROM (bead ro-ujb9.76.22). A self-hosted
// installation has exactly one workspace, created once by its bootstrap, and
// the store itself names it: `onlyWorkspace()` asks noticeos.only_workspace()
// (0001_baseline.sql), which answers the id while exactly one workspace exists.
// So a Worker request or a script gets its id from the store it already
// reaches, and no id is copied into a file or a binding (D30). With none or
// several it throws NoSingleWorkspace, and no transaction is opened. A hosted
// installation with several workspaces names each request's workspace itself
// and passes it to `inWorkspace`.
//
// `work` runs one statement per call, with $1…$n parameters. The helper owns the
// transaction and its settings, so a statement that controls the transaction
// (BEGIN, COMMIT, SAVEPOINT …), changes a setting (SET, RESET, DISCARD) or names
// noticeos.workspace_id is refused before it is sent.
//
// VALUES ARE EXACT BOTH WAYS.
//   Postgres → JavaScript:
//     int8                    bigint (9007199254740993n, never a rounded number)
//     int2, int4, oid         number
//     float4, float8          number (the server prints the shortest exact form)
//     numeric                 string as the server prints it ('0.000625', scale kept)
//     timestamptz             string, ISO 8601 UTC with six fraction digits
//                             ('2026-09-05T01:02:03.456789Z'), so string order is
//                             time order and microseconds survive
//     date                    'YYYY-MM-DD' (never a Date at some local midnight)
//     json, jsonb             string: the server's text (json byte for byte);
//                             JSON.parse is the caller's own step
//     bytea                   Uint8Array
//     bool                    boolean
//     one-dimensional arrays of these, as arrays; everything else (text, uuid,
//     interval …) is the server's text. NULL is null and '' is ''.
//   JavaScript → Postgres: null is NULL and '' is ''; undefined is refused. A
//   bigint or a string for int8 and numeric; a number must be finite and, when
//   whole, a safe integer. A Date is its millisecond instant; a Uint8Array is
//   bytea; arrays of the above are arrays. Any other object is refused:
//   JSON.stringify it for a json or jsonb column.
//
// CONNECTING. `openStore(connectionString)` keeps a small pool (at most five
// connections, the Workers' guidance for Hyperdrive). In a Worker the string is
// the Hyperdrive binding's `connectionString`, and a store is opened per
// request and closed with `ctx.waitUntil(store.close())`. The string is the
// whole configuration: which host, database and login (noticeos_app) it names
// is the operator's, never this module's.

import { Pool, type PoolClient, type QueryConfig } from 'pg';

/** The role every transaction must be connected as (db/postgres/roles.sql). */
export const APPLICATION_ROLE = 'noticeos_app';
/** The per-transaction setting forced row security reads (0001_baseline.sql). */
export const WORKSPACE_SETTING = 'noticeos.workspace_id';
/** Connections one store opens at most, unless told otherwise. */
export const DEFAULT_MAX_CONNECTIONS = 5;

/** A value a statement's parameter may carry (see the header for each rule). */
export type SqlValue = string | number | bigint | boolean | Date | Uint8Array | null | readonly SqlValue[];

/** One row: column name → value, parsed by the rules in the header. */
export type Row = Record<string, unknown>;

/** The statements `work` runs, all inside its one transaction. */
export interface Transaction {
  /** The workspace this transaction acts for, for statements that bind it. */
  readonly workspaceId: string;
  /** One statement; its rows. */
  query<R extends Row = Row>(sql: string, params?: readonly SqlValue[]): Promise<R[]>;
  /** One statement; how many rows it inserted, changed or removed. */
  execute(sql: string, params?: readonly SqlValue[]): Promise<number>;
}

export interface TransactionOptions {
  /** Open the transaction READ ONLY: a reader that cannot write by mistake. */
  readonly readOnly?: boolean;
}

export interface PostgresStore {
  /** The installation's one workspace id, named by the store; see the header.
   * Throws NoSingleWorkspace, before any transaction opens, when the store holds
   * none or several. */
  onlyWorkspace(): Promise<string>;
  /** Run `work` in one transaction that names `workspaceId`; see the header. */
  inWorkspace<T>(workspaceId: string, work: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /** Close every connection. A closed store opens no more transactions. */
  close(): Promise<void>;
}

export interface StoreOptions {
  /** Connections open at most (default 5). */
  readonly maxConnections?: number;
}

/** The helper refused: nothing was sent, or what was sent is rolled back. */
export class TransactionRefused extends Error {
  override name = 'TransactionRefused';
}

/** The transaction did not commit, although `work` returned: a statement failed
 * (and `work` went on), or Postgres ended it with ROLLBACK. Nothing was kept. */
export class TransactionRolledBack extends Error {
  override name = 'TransactionRolledBack';
}

/** The store holds no workspace yet, or several: it names no only workspace,
 * and no transaction was opened. A new installation creates its one workspace
 * once, at its bootstrap (db/postgres/README.md); an installation with several
 * names the workspace of each request instead. */
export class NoSingleWorkspace extends TransactionRefused {
  override name = 'NoSingleWorkspace';
}

// ─── Postgres → JavaScript ──────────────────────────────────────────────────

type Parse = (text: string) => unknown;

const asText: Parse = (text) => text;

function parseBytea(text: string): Uint8Array {
  if (!/^\\x(?:[0-9a-f]{2})*$/iu.test(text)) throw new TypeError('bytea is read as hex (bytea_output = hex)');
  const bytes = new Uint8Array((text.length - 2) / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(text.slice(2 + i * 2, 4 + i * 2), 16);
  return bytes;
}

const PG_INSTANT = /^(\d{4,})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?([+-])(\d\d)(?::(\d\d))?$/u;

/** '2026-09-05 01:02:03.4+00' → '2026-09-05T01:02:03.400000Z'. */
function isoInstant(text: string): string {
  if (text === 'infinity' || text === '-infinity') return text;
  const match = PG_INSTANT.exec(text);
  if (!match) throw new TypeError(`timestamptz ${text} is not in the ISO form this helper sets`);
  const [, year, month, day, hour, minute, second, fraction = '', sign, offsetHours, offsetMinutes = '00'] = match;
  const offset = offsetHours === '00' && offsetMinutes === '00' ? 'Z' : `${sign}${offsetHours}:${offsetMinutes}`;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(6, '0')}${offset}`;
}

/** A one-dimensional array literal ('{1,NULL,"a,b"}'), each element parsed. */
function parseArray(text: string, parseElement: Parse): unknown[] {
  if (!text.startsWith('{') || !text.endsWith('}')) {
    throw new TypeError(`only one-dimensional arrays with default bounds are read, not ${text.slice(0, 40)}`);
  }
  const body = text.slice(1, -1);
  const items: unknown[] = [];
  let i = 0;
  while (body !== '') {
    if (body[i] === '{') throw new TypeError('multi-dimensional arrays are not read');
    if (body[i] === '"') {
      let value = '';
      i += 1;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === '\\') i += 1;
        value += body[i] ?? '';
        i += 1;
      }
      i += 1;
      items.push(parseElement(value));
    } else {
      const end = body.indexOf(',', i) === -1 ? body.length : body.indexOf(',', i);
      const raw = body.slice(i, end);
      items.push(raw === 'NULL' ? null : parseElement(raw));
      i = end;
    }
    if (i >= body.length) break;
    if (body[i] !== ',') throw new TypeError(`malformed array ${text.slice(0, 40)}`);
    i += 1;
  }
  return items;
}

/** Parsers by type oid; any type not here is read as the server's text. */
const SCALARS: Record<number, Parse> = {
  16: (text) => text === 't', // bool
  17: parseBytea, // bytea
  20: (text) => BigInt(text), // int8
  21: Number, // int2
  23: Number, // int4
  26: Number, // oid
  700: Number, // float4
  701: Number, // float8
  1184: isoInstant, // timestamptz
};

/** Array type oid → its element's type oid. */
const ARRAYS: Record<number, number> = {
  1000: 16, 1001: 17, 1005: 21, 1007: 23, 1016: 20, 1028: 26, 1021: 700, 1022: 701,
  1185: 1184, 1182: 1082, 1115: 1114, 1231: 1700, 1009: 25, 1015: 1043, 2951: 2950,
  199: 114, 3807: 3802,
};

/** The one parser table every statement's results go through. */
export function exactTypeParser(oid: number, format: string = 'text'): Parse {
  if (format !== 'text') throw new TypeError(`results are read as text; type ${oid} came as ${format}`);
  const scalar = SCALARS[oid];
  if (scalar) return scalar;
  const element = ARRAYS[oid];
  if (element !== undefined) {
    const parseElement = SCALARS[element] ?? asText;
    return (text) => parseArray(text, parseElement);
  }
  return asText;
}

const EXACT_TYPES = { getTypeParser: exactTypeParser };

/**
 * An instant as JavaScript writes one — `Date#toISOString()`, milliseconds and
 * `Z` — from the form this helper reads (`…:03.456789Z`). For a module whose
 * callers compare instants as strings with ones JavaScript made: the two forms
 * of one instant do not compare equal, or even in order, as strings. An
 * instant JavaScript wrote comes back unchanged; a server-made one
 * (`DEFAULT now()`) loses its microseconds. Anything that is not an instant
 * is refused.
 */
export function javascriptInstant(instant: string): string {
  const ms = typeof instant === 'string' ? Date.parse(instant) : Number.NaN;
  if (!Number.isFinite(ms)) throw new TypeError(`${String(instant)} is not an instant`);
  return new Date(ms).toISOString();
}

// ─── JavaScript → Postgres ──────────────────────────────────────────────────

function sqlParameter(value: unknown, where: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'number':
      if (!Number.isFinite(value)) throw new TransactionRefused(`${where}: ${value} is not a finite number`);
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new TransactionRefused(`${where}: ${value} is past 2^53 and no longer exact; pass a BigInt or a string`);
      }
      return String(value);
    case 'undefined':
      throw new TransactionRefused(`${where} is undefined; pass null for NULL`);
    default:
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TransactionRefused(`${where}: an invalid Date`);
    return value.toISOString();
  }
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    return value.map((item: unknown, index) => {
      if (item instanceof Uint8Array) throw new TransactionRefused(`${where}[${index}]: bytes inside a list are not sent`);
      return sqlParameter(item, `${where}[${index}]`);
    });
  }
  throw new TransactionRefused(`${where}: an object is not a SQL value; JSON.stringify it for a json or jsonb column`);
}

// ─── Statements ─────────────────────────────────────────────────────────────

const LEADING_TRIVIA = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u;
const HELPER_OWNED = /^(begin|start|commit|end|rollback|abort|savepoint|release|prepare|set|reset|discard)\b/iu;
const WORKSPACE_NAME = /noticeos\.workspace_id/iu;

function checkStatement(sql: unknown): string {
  if (typeof sql !== 'string') throw new TransactionRefused('a statement is SQL text');
  const body = sql.replace(LEADING_TRIVIA, '');
  if (body === '') throw new TransactionRefused('an empty statement');
  const owned = HELPER_OWNED.exec(body);
  if (owned) {
    throw new TransactionRefused(`${owned[1]?.toUpperCase()} is the helper's: it owns the transaction and its settings`);
  }
  if (WORKSPACE_NAME.test(sql)) throw new TransactionRefused(`${WORKSPACE_SETTING} is set once, by inWorkspace`);
  return sql;
}

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function checkWorkspace(workspaceId: unknown): string {
  if (typeof workspaceId !== 'string' || !WORKSPACE_ID.test(workspaceId)) {
    throw new TransactionRefused(`a transaction names its workspace as a lower-case UUID, not ${String(workspaceId)}`);
  }
  return workspaceId;
}

/** Who the connection is, read in the same statement as what it asks. */
const CONNECTED_AS = [
  '  session_user::text AS session_role,',
  '  current_user::text AS acting_role,',
  '  r.rolsuper OR r.rolbypassrls AS bypasses_row_security',
  'FROM pg_catalog.pg_roles r',
  'WHERE r.rolname = current_user',
];

/** BEGIN and the transaction's settings in one round trip. The id was checked
 * against WORKSPACE_ID, so it is safe inside the literal. */
function openingSql(workspaceId: string, readOnly: boolean): string {
  return [
    readOnly ? 'BEGIN READ ONLY;' : 'BEGIN;',
    'SELECT',
    `  set_config('${WORKSPACE_SETTING}', '${workspaceId}', true) AS workspace_id,`,
    "  set_config('TimeZone', 'UTC', true) AS time_zone,",
    "  set_config('DateStyle', 'ISO, YMD', true) AS date_style,",
    "  set_config('extra_float_digits', '1', true) AS float_digits,",
    "  set_config('bytea_output', 'hex', true) AS bytea_output,",
    ...CONNECTED_AS,
  ].join('\n');
}

/** The store's answer for its one workspace, in one statement and no transaction. */
const ONLY_WORKSPACE_SQL = ['SELECT', '  noticeos.only_workspace()::text AS workspace_id,', ...CONNECTED_AS].join('\n');

function checkConnectedAs(row: Row | undefined): asserts row is Row {
  if (row?.session_role !== APPLICATION_ROLE || row.acting_role !== APPLICATION_ROLE) {
    throw new TransactionRefused(
      `connected as ${String(row?.session_role)}; the application connects as ${APPLICATION_ROLE} only`,
    );
  }
  if (row.bypasses_row_security !== false) {
    throw new TransactionRefused(`${APPLICATION_ROLE} must not be a superuser or bypass row security`);
  }
}

function checkOpened(row: Row | undefined, workspaceId: string): void {
  if (row?.workspace_id !== workspaceId) throw new TransactionRefused('the workspace setting did not take');
  checkConnectedAs(row);
}

// ─── The transaction ────────────────────────────────────────────────────────

/** What a statement returns, as the driver reports it. */
export interface ClientResult {
  readonly rows: unknown[];
  readonly rowCount: number | null;
  readonly command: string;
}

/** One statement for the driver: SQL, parameters, the parser table, and (for
 * work's statements) the extended protocol, which takes one statement only. */
export interface ClientQuery {
  readonly text: string;
  readonly values?: unknown[];
  readonly types: typeof EXACT_TYPES;
  readonly queryMode?: 'extended';
}

/** One held connection: a node-postgres client, or anything that answers alike. */
export interface QueryClient {
  query(query: ClientQuery): Promise<ClientResult | ClientResult[]>;
}

const lastResult = (result: ClientResult | ClientResult[]): ClientResult => {
  const last = Array.isArray(result) ? result.at(-1) : result;
  if (!last) throw new TransactionRefused('Postgres returned no result');
  return last;
};

/**
 * The transaction `inWorkspace` runs, on a connection the caller holds. A store
 * calls it with a pooled connection; a proof calls it with its own, to look at
 * the connection afterwards.
 */
export async function runInWorkspace<T>(
  client: QueryClient,
  workspaceId: string,
  work: (tx: Transaction) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  checkWorkspace(workspaceId);
  let open = true;
  // Statements go to the connection one after another, in the order work
  // called them (work may start several at once); `settled` is the last one.
  let settled: Promise<void> = Promise.resolve();
  // Every failed statement, kept even when work catches it and goes on.
  const failures: unknown[] = [];
  const run = async (sql: string, params: readonly SqlValue[] = []): Promise<ClientResult> => {
    if (!open) throw new TransactionRefused('this transaction has ended; run statements inside its work');
    const text = checkStatement(sql);
    const values = params.map((value, index) => sqlParameter(value, `$${index + 1}`));
    const result = settled.then(() => client.query({ text, values, types: EXACT_TYPES, queryMode: 'extended' }));
    settled = result.then(
      () => undefined,
      (error: unknown) => {
        failures.push(error);
      },
    );
    return lastResult(await result);
  };
  const tx: Transaction = {
    workspaceId,
    query: async <R extends Row = Row>(sql: string, params?: readonly SqlValue[]) => (await run(sql, params)).rows as R[],
    execute: async (sql, params) => (await run(sql, params)).rowCount ?? 0,
  };
  try {
    const opened = lastResult(await client.query({ text: openingSql(workspaceId, options.readOnly === true), types: EXACT_TYPES }));
    checkOpened(opened.rows[0] as Row | undefined, workspaceId);
    let value: T;
    try {
      value = await work(tx);
    } finally {
      // Nothing starts once work is over; what it started finishes first.
      open = false;
      await settled;
    }
    if (failures.length > 0) {
      throw new TransactionRolledBack('a statement failed inside the transaction, so none of it was kept', {
        cause: failures[0],
      });
    }
    const committed = lastResult(await client.query({ text: 'COMMIT', types: EXACT_TYPES }));
    if (committed.command !== 'COMMIT') {
      throw new TransactionRolledBack(`Postgres ended the transaction with ${committed.command}, so none of it was kept`);
    }
    return value;
  } catch (error) {
    open = false;
    await settled;
    await client.query({ text: 'ROLLBACK', types: EXACT_TYPES }).catch(() => undefined);
    throw error;
  }
}

/**
 * The workspace the store names as its only one, asked on a connection the
 * caller holds: one statement, outside any transaction. Throws
 * NoSingleWorkspace when the store holds none or several, and refuses a
 * connection that is not the application role, like `runInWorkspace`.
 */
export async function findOnlyWorkspace(client: QueryClient): Promise<string> {
  const found = lastResult(await client.query({ text: ONLY_WORKSPACE_SQL, types: EXACT_TYPES }));
  const row = found.rows[0] as Row | undefined;
  checkConnectedAs(row);
  if (row.workspace_id === null || row.workspace_id === undefined) {
    throw new NoSingleWorkspace('the store names no single workspace; its bootstrap creates one (db/postgres/README.md)');
  }
  return checkWorkspace(row.workspace_id);
}

// ─── The store ──────────────────────────────────────────────────────────────

/** A node-postgres connection seen as a QueryClient. */
const onConnection = (client: PoolClient): QueryClient => ({
  query: (query) => client.query(query as QueryConfig) as Promise<ClientResult | ClientResult[]>,
});

/** A store on `connectionString` (a Worker: its Hyperdrive binding's). */
export function openStore(connectionString: string, options: StoreOptions = {}): PostgresStore {
  if (typeof connectionString !== 'string' || connectionString === '') {
    throw new TransactionRefused('a store needs a connection string');
  }
  // No `allowExitOnIdle`: it makes the pool call unref() on its timers and
  // connections, which a Worker's have not, so every release threw there
  // (found by workers/ingest/test/postgres-store.test.ts). A script closes its
  // store; one that forgets exits once the idle connections time out (10 s).
  const pool = new Pool({
    connectionString,
    max: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    connectionTimeoutMillis: 10_000,
  });
  // An idle connection that breaks is dropped by the pool; the next
  // transaction opens a new one or fails on its own. Without a listener Node
  // would treat the pool's error event as a crash.
  pool.on('error', () => undefined);
  let closed = false;
  /** `use` on one pooled connection; one that saw a failure never goes back. */
  const withConnection = async <T,>(use: (client: QueryClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    let broken = false;
    // A connection that breaks while in use (a server restart, a failover, a
    // session the server ended) fails the work on it: its statement rejects.
    // The pool listens for errors only while a connection is idle, so without
    // this listener Node would treat the connection's error event as a crash.
    const broke = () => {
      broken = true;
    };
    client.on('error', broke);
    try {
      return await use(onConnection(client));
    } catch (error) {
      broken = true;
      throw error;
    } finally {
      client.removeListener('error', broke);
      client.release(broken);
    }
  };
  return {
    async onlyWorkspace() {
      if (closed) throw new TransactionRefused('this store is closed');
      return withConnection(findOnlyWorkspace);
    },
    async inWorkspace(workspaceId, work, transactionOptions) {
      if (closed) throw new TransactionRefused('this store is closed');
      checkWorkspace(workspaceId);
      return withConnection((client) => runInWorkspace(client, workspaceId, work, transactionOptions));
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}

// ─── The store one call works in ────────────────────────────────────────────
//
// WHAT A PORTED MODULE TAKES (the port pattern,
// docs/briefs/2026-09-29-postgres-port-pattern.md). A Worker opens one per
// call — a request, a scheduled run, an RPC call — and closes it when the call
// ends; a script opens one per run. It finds the workspace once (the store's
// only one, unless the caller names another) and runs each unit of work in a
// transaction of its own: `read` READ ONLY, `write` committed whole or not at
// all. Nothing connects before the first unit of work, so a call that never
// touches the store costs nothing.

/** The store one call works in: one workspace, a transaction per unit of work. */
export interface WorkspaceStore {
  /** Where the store is — host, port and database, never a credential — for
   * a cache key or a message. */
  readonly where: string;
  /** The workspace this store acts for: the one the caller named, or the
   * store's only one, asked once. */
  workspaceId(): Promise<string>;
  /** `work` in one READ ONLY transaction in the workspace. */
  read<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  /** `work` in one transaction in the workspace, committed whole or not at all. */
  write<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Close every connection; a closed store runs no more work. */
  close(): Promise<void>;
}

export interface WorkspaceStoreOptions extends StoreOptions {
  /** The workspace to act for, where an installation has several; otherwise the store's only one. */
  readonly workspaceId?: string;
}

/** Host, port and database of a connection string, never its credential. */
export function storeLocation(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const host = url.hostname || url.searchParams.get('host') || 'localhost';
    return `${host}:${url.port || '5432'}${url.pathname}`;
  } catch {
    return 'a store whose connection string is not a URL';
  }
}

/** A Worker's Hyperdrive binding, as far as a call's store reads it. */
export interface StoreBinding {
  readonly connectionString: string;
}

/** The part of a Worker's execution context a call's store needs. */
export interface CallContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** A direct connection selected by server deployment code, never a request. */
export interface DirectPostgresTransport {
  readonly kind: 'direct';
  readonly connectionString: string;
}

/** Inputs supplied after the server has authorized this operation. This
 * structural type and its workspace UUID do not establish authorization. */
export interface HostedStoreCall {
  readonly transport: DirectPostgresTransport;
  readonly workspace: { readonly workspaceId: string };
}

/** A store that refuses every unit of work, saying why. */
function refusingStore(why: string): WorkspaceStore {
  const refuse = <T,>(): Promise<T> => Promise.reject(new TransactionRefused(why));
  return { where: 'no store', workspaceId: refuse, read: refuse, write: refuse, close: async () => undefined };
}

/**
 * `work` with a store opened for this call alone on `binding` (a Worker's
 * POSTGRES Hyperdrive binding), closed once `work` has finished, through
 * `ctx.waitUntil`. The whole lifecycle of a Worker's store: a connection may
 * not outlive the request that opened it, and Hyperdrive pools behind the
 * binding. With no binding the store refuses each unit of work, naming why,
 * so a call that never reads the store still runs.
 */
export async function withWorkspaceStore<T>(
  binding: StoreBinding | undefined,
  ctx: CallContext,
  work: (store: WorkspaceStore) => Promise<T>,
): Promise<T> {
  const store = binding ? openWorkspaceStore(binding.connectionString) : refusingStore('this Worker has no POSTGRES binding');
  return withCallScopedStore(store, ctx, work);
}

/** The caller must authenticate and authorize the operation before calling.
 * This helper validates shape, not authority. It accepts only an explicit
 * server-selected direct transport and workspace; it never discovers the sole
 * workspace or reads an ambient address. Invalid inputs refuse before work or
 * any connection, without putting supplied values in the error. */
export async function withHostedWorkspaceStore<T>(
  call: HostedStoreCall,
  ctx: CallContext,
  work: (store: WorkspaceStore) => Promise<T>,
): Promise<T> {
  let connectionString: string;
  let workspaceId: string;
  try {
    if (!call || typeof call !== 'object' || Array.isArray(call)) throw new Error();
    const { transport, workspace } = call;
    if (!transport || typeof transport !== 'object' || Array.isArray(transport) || transport.kind !== 'direct' ||
        !workspace || typeof workspace !== 'object' || Array.isArray(workspace)) throw new Error();
    connectionString = transport.connectionString;
    workspaceId = workspace.workspaceId;
    if (typeof connectionString !== 'string' || connectionString.trim() === '' ||
        typeof workspaceId !== 'string' || !WORKSPACE_ID.test(workspaceId)) throw new Error();
    const address = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(address.protocol) ||
        address.pathname.length <= 1 || !(address.hostname || address.searchParams.get('host'))) throw new Error();
  } catch {
    throw new TransactionRefused('a hosted store needs an explicit direct PostgreSQL transport and workspace');
  }
  return withCallScopedStore(openWorkspaceStore(connectionString, { workspaceId }), ctx, work);
}

/** Standalone and hosted calls share the same awaited closing obligation. */
async function withCallScopedStore<T>(
  store: WorkspaceStore,
  ctx: CallContext,
  work: (store: WorkspaceStore) => Promise<T>,
): Promise<T> {
  try {
    return await work(store);
  } finally {
    ctx.waitUntil(store.close());
  }
}

/** A WorkspaceStore on `connectionString` (a Worker: its Hyperdrive binding's). */
export function openWorkspaceStore(connectionString: string, options: WorkspaceStoreOptions = {}): WorkspaceStore {
  const store = openStore(connectionString, options);
  let found: Promise<string> | null =
    options.workspaceId === undefined ? null : Promise.resolve(checkWorkspace(options.workspaceId));
  const workspaceId = (): Promise<string> =>
    (found ??= store.onlyWorkspace().catch((error: unknown) => {
      // Not remembered: the next unit of work asks again.
      found = null;
      throw error;
    }));
  return {
    where: storeLocation(connectionString),
    workspaceId,
    read: async (work) => store.inWorkspace(await workspaceId(), work, { readOnly: true }),
    write: async (work) => store.inWorkspace(await workspaceId(), work),
    close: () => store.close(),
  };
}
