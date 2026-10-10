// The store's capacity inventory: how big each table is, how fast it grows,
// and how much of that is insight snapshots and raw archive objects. Read-only
// and metadata only: names, counts, byte totals and arrival timestamps, never
// a stored value. One query per table, run one after another, so the regular
// lanes interleave. `valueBytes` is `pg_column_size` of the stored values,
// excluding indexes and page overhead; physical relation sizes cover the whole
// database, so they are reported only for a store holding this workspace alone.

import { javascriptInstant, type WorkspaceStore } from '@noticeos/postgres';
import tableCatalog from '../../../db/postgres/tables.json';

/** Rows accumulate and are kept; rows are bounded by the number of things;
 * rows accumulate but a retention sweep removes old ones. */
export type TableShape = 'history' | 'state' | 'cache';

interface CatalogEntry {
  shape: TableShape;
  /** The column stamping when a row arrived; null where no row has one. */
  arrival: string | null;
  /** Arrival lives on a parent row, joined inside the same workspace. */
  arrivalVia?: { table: string; column: string; key: string };
}

const CATALOG = (tableCatalog as { tables: Record<string, CatalogEntry> }).tables;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quote(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new Error(`capacity: refusing an unexpected identifier ${JSON.stringify(identifier)}`);
  }
  return `"${identifier}"`;
}

/** The two growth windows, in whole UTC days. */
export const CAPACITY_SHORT_DAYS = 7;
export const CAPACITY_LONG_DAYS = 30;
/** The raw-archive listing stops after this many pages of 1,000 objects. */
export const CAPACITY_ARCHIVE_PAGE_LIMIT = 100;

export interface TableCapacity {
  name: string;
  shape: TableShape | 'undeclared';
  rows: number;
  valueBytes: number;
  /** Heap, indexes and TOAST; null when other workspaces share the store. */
  relationBytes: number | null;
  largestColumn: { name: string; bytes: number } | null;
  arrival: string | null;
  firstAt: string | null;
  lastAt: string | null;
  rowsShortWindow: number | null;
  rowsLongWindow: number | null;
  bytesLongWindow: number | null;
  rowsPerDay: number | null;
  bytesPerDay: number | null;
  scanMs: number;
}

export interface SnapshotAssetCapacity {
  asset: string;
  rows: number;
  payloadBytes: number;
  maxPayloadBytes: number;
  rowsLongWindow: number;
  bytesLongWindow: number;
  publishDaysLongWindow: number;
  newestPayloadBytes: number;
}

export interface SnapshotCapacity {
  rows: number;
  payloadBytes: number;
  maxPayloadBytes: number;
  rowsPerDay: number;
  bytesPerDay: number;
  /** The two newest rows per site — the only rows any surface reads
   * (`SNAPSHOTS_READ_PER_SITE`). */
  readRows: number;
  readBytes: number;
  /** Every older row: kept as history, read by nothing today. */
  supersededRows: number;
  supersededBytes: number;
  byAsset: SnapshotAssetCapacity[];
}

export interface ArchiveIntegrationCapacity {
  integration: string;
  runs: number;
  success: number;
  unchanged: number;
  error: number;
  objects: number;
  objectBytes: number;
  newObjectsLongWindow: number;
  newBytesLongWindow: number;
}

export interface ArchiveCapacity {
  /** From the manifests (the report runs and the objects they name): each
   * object counted once. */
  manifests: {
    runs: number;
    objects: number;
    objectBytes: number;
    objectsPerDay: number;
    bytesPerDay: number;
    byIntegration: ArchiveIntegrationCapacity[];
  };
  /** From listing the bucket itself (keys and sizes only), bounded. */
  bucket: {
    objects: number;
    bytes: number;
    truncated: boolean;
    byPrefix: { prefix: string; objects: number; bytes: number }[];
  } | { error: string };
}

export interface LaneCapacity {
  job: string;
  runs: number;
  failed: number;
  skipped: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface CapacityInventory {
  generatedAt: string;
  windows: { shortDays: number; longDays: number; shortSince: string; longSince: string };
  store: {
    bytes: number | null;
    valueBytes: number;
    unattributedBytes: number | null;
    tables: number;
    views: string[];
    /** Catalogued tables this store does not have: unapplied migrations. */
    missingTables: string[];
    rows: number;
    /** Arrivals per day into the tables that keep every row (`history`). Cache
     * tables delete as they add, and state tables hold one row per thing, so
     * neither is growth. */
    historyRowsPerDay: number;
    historyBytesPerDay: number;
    scanMs: number;
  };
  tables: TableCapacity[];
  insightSnapshots: SnapshotCapacity | null;
  archive: ArchiveCapacity | null;
  lanes: LaneCapacity[] | null;
}

type ListedObject = {
  name: string;
  type: string;
};

function dayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days the long window really covers for a table whose first row is
 * `firstAt`: a table born ten days ago grew for ten days, not thirty. */
function observedDays(nowMs: number, longSince: string, firstAt: string | null): number {
  const windowStart = Date.parse(`${longSince}T00:00:00Z`);
  const first = firstAt === null ? Number.NaN : Date.parse(firstAt.length === 10 ? `${firstAt}T00:00:00Z` : firstAt);
  const start = Number.isFinite(first) ? Math.max(windowStart, first) : windowStart;
  return Math.max(1, (nowMs - start) / 86_400_000);
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

async function listObjects(store: WorkspaceStore): Promise<{
  objects: (ListedObject & { columns: string[]; bytes: number | null })[];
  bytes: number | null;
}> {
  return store.read(async (tx) => {
    // RLS does not apply to physical sizes. The existing bootstrap function
    // returns an id only while exactly one workspace exists, without listing
    // anybody else's id. Shared stores expose scoped value totals instead.
    const [size] = await tx.query<{ bytes: number | null }>(
      `SELECT CASE WHEN noticeos.only_workspace() = $1::uuid
                   THEN pg_database_size(current_database())::float8 END AS bytes`,
      [tx.workspaceId],
    );
    const objects = await tx.query<ListedObject & { columns: string[]; bytes: number | null }>(
      `SELECT c.relname AS name, CASE WHEN c.relkind = 'v' THEN 'view' ELSE 'table' END AS type,
              ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                     ORDER BY a.attnum) AS columns,
              CASE WHEN noticeos.only_workspace() = $1::uuid AND c.relkind IN ('r', 'p')
                   THEN pg_total_relation_size(c.oid)::float8 END AS bytes
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'noticeos' AND c.relkind IN ('r', 'p', 'v')
        ORDER BY c.relname COLLATE "C"`,
      [tx.workspaceId],
    );
    return { objects, bytes: size?.bytes ?? null };
  });
}

async function measureTable(
  store: WorkspaceStore,
  table: string,
  columns: readonly string[],
  entry: CatalogEntry | undefined,
  present: ReadonlySet<string>,
  nowMs: number,
  shortSince: string,
  longSince: string,
  relationBytes: number | null,
): Promise<TableCapacity> {
  const t = quote(table);
  const lengthOf = (column: string) => `COALESCE(pg_column_size(t.${quote(column)}), 0)::bigint`;
  const rowBytes = columns.length > 0 ? columns.map(lengthOf).join(' + ') : '0';

  // Arrival: this row's own stamp, or its parent's where the row has none.
  let arrivalExpr: string | null = null;
  let join = '';
  if (entry?.arrival) {
    if (entry.arrivalVia && present.has(entry.arrivalVia.table)) {
      join = ` LEFT JOIN noticeos.${quote(entry.arrivalVia.table)} p
                ON p.workspace_id = t.workspace_id AND p.${quote(entry.arrivalVia.key)} = t.${quote(entry.arrivalVia.column)}`;
      arrivalExpr = `p.${quote(entry.arrival)}`;
    } else if (!entry.arrivalVia && columns.includes(entry.arrival)) {
      arrivalExpr = `t.${quote(entry.arrival)}`;
    }
  }

  const select = [
    'COUNT(*)::float8 AS n',
    ...columns.map((column, i) => `SUM(${lengthOf(column)}) AS c${i}`),
  ];
  if (arrivalExpr) {
    select.push(
      `MIN(${arrivalExpr}) AS first_at`,
      `MAX(${arrivalExpr}) AS last_at`,
      `COUNT(*) FILTER (WHERE ${arrivalExpr} >= $1::date)::float8 AS short_n`,
      `COUNT(*) FILTER (WHERE ${arrivalExpr} >= $2::date)::float8 AS long_n`,
      `SUM(CASE WHEN ${arrivalExpr} >= $2::date THEN ${rowBytes} ELSE 0 END) AS long_bytes`,
    );
  }
  const started = performance.now();
  const result = await store.read((tx) => tx.query<Record<string, unknown>>(
    `SELECT ${select.join(', ')} FROM noticeos.${t} t${join}`,
    arrivalExpr ? [shortSince, longSince] : [],
  ));
  const scanMs = round(performance.now() - started);
  const row = result[0] ?? {};

  let valueBytes = 0;
  let largest: { name: string; bytes: number } | null = null;
  for (const [i, column] of columns.entries()) {
    const bytes = num(row[`c${i}`]);
    valueBytes += bytes;
    if (bytes > 0 && (largest === null || bytes > largest.bytes)) largest = { name: column, bytes };
  }

  const stamp = (value: unknown) => typeof value === 'string'
    ? value.length === 10 ? value : javascriptInstant(value)
    : null;
  const firstAt = stamp(row.first_at);
  const lastAt = stamp(row.last_at);
  const rowsLong = arrivalExpr ? num(row.long_n) : null;
  const bytesLong = arrivalExpr ? num(row.long_bytes) : null;
  const days = observedDays(nowMs, longSince, firstAt);
  return {
    name: table,
    shape: entry?.shape ?? 'undeclared',
    rows: num(row.n),
    valueBytes,
    relationBytes,
    largestColumn: largest,
    arrival: arrivalExpr ? entry?.arrival ?? null : null,
    firstAt,
    lastAt,
    rowsShortWindow: arrivalExpr ? num(row.short_n) : null,
    rowsLongWindow: rowsLong,
    bytesLongWindow: bytesLong,
    rowsPerDay: rowsLong === null ? null : round(rowsLong / days),
    bytesPerDay: bytesLong === null ? null : Math.round(bytesLong / days),
    scanMs,
  };
}

/**
 * How many insight snapshots per site the Tower reads: the site page reads the
 * newest and the Wall's feed compares it with the one before;
 * scripts/postgres-model.test.mjs holds them together.
 */
const SNAPSHOTS_READ_PER_SITE = 2;

async function measureSnapshots(store: WorkspaceStore, nowMs: number, longSince: string): Promise<SnapshotCapacity> {
  // A payload's size is its stored text's bytes; an arrival's day is its UTC day.
  const { found, read } = await store.read(async (tx) => ({
    found: await tx.query<Record<string, unknown>>(
      `SELECT asset_id AS asset,
              count(*)::int AS n,
              sum(octet_length(payload::text))::float8 AS bytes,
              max(octet_length(payload::text)) AS max_bytes,
              count(*) FILTER (WHERE created_at >= $1::date)::int AS long_n,
              COALESCE(sum(octet_length(payload::text)) FILTER (WHERE created_at >= $1::date), 0)::float8 AS long_bytes,
              count(DISTINCT (created_at AT TIME ZONE 'UTC')::date) FILTER (WHERE created_at >= $1::date)::int AS long_days,
              min(created_at) AS first_at
         FROM noticeos.asset_insight_snapshots
        GROUP BY asset_id
        ORDER BY asset_id COLLATE "C"`,
      [longSince],
    ),
    // The rows the Tower reads per site, newest first, by the same order it
    // reads them and the store keeps them (`noticeos.insight_snapshot_is_kept`).
    read: await tx.query<{ asset: string; rn: number; bytes: number }>(
      `SELECT asset, rn, bytes
         FROM (SELECT asset_id AS asset, octet_length(payload::text) AS bytes,
                      (ROW_NUMBER() OVER (PARTITION BY asset_id
                                          ORDER BY generated_at DESC, created_at DESC, snapshot_id DESC))::int AS rn
                 FROM noticeos.asset_insight_snapshots) ranked
        WHERE rn <= $1`,
      [SNAPSHOTS_READ_PER_SITE],
    ),
  }));
  const byAsset: Record<string, unknown>[] = found.map((row) => ({
    ...row,
    first_at: typeof row.first_at === 'string' ? javascriptInstant(row.first_at) : null,
  }));
  const newestBytes = new Map(read.filter((row) => num(row.rn) === 1).map((row) => [row.asset, num(row.bytes)]));
  const readBytes = read.reduce((sum, row) => sum + num(row.bytes), 0);

  let rows = 0;
  let payloadBytes = 0;
  let maxPayloadBytes = 0;
  let rowsPerDay = 0;
  let bytesPerDay = 0;
  const assets: SnapshotAssetCapacity[] = byAsset.map((row) => {
    const asset = String(row.asset);
    const days = observedDays(nowMs, longSince, typeof row.first_at === 'string' ? row.first_at : null);
    rows += num(row.n);
    payloadBytes += num(row.bytes);
    maxPayloadBytes = Math.max(maxPayloadBytes, num(row.max_bytes));
    rowsPerDay += num(row.long_n) / days;
    bytesPerDay += num(row.long_bytes) / days;
    return {
      asset,
      rows: num(row.n),
      payloadBytes: num(row.bytes),
      maxPayloadBytes: num(row.max_bytes),
      rowsLongWindow: num(row.long_n),
      bytesLongWindow: num(row.long_bytes),
      publishDaysLongWindow: num(row.long_days),
      newestPayloadBytes: newestBytes.get(asset) ?? 0,
    };
  });
  return {
    rows,
    payloadBytes,
    maxPayloadBytes,
    rowsPerDay: round(rowsPerDay),
    bytesPerDay: Math.round(bytesPerDay),
    readRows: read.length,
    readBytes,
    supersededRows: rows - read.length,
    supersededBytes: payloadBytes - readBytes,
    byAsset: assets,
  };
}

async function measureArchive(
  env: Pick<IngestEnv, 'RAW_SIGNALS' | 'STORE'>,
  nowMs: number,
  longSince: string,
  singleWorkspace: boolean,
): Promise<ArchiveCapacity> {
  // An unchanged run points at the object an earlier run stored, so objects are
  // counted once each (`noticeos.archive_objects`), under the integration of
  // the runs that name them, and dated by the run that first stored them.
  const { byIntegration, first } = await env.STORE.read(async (tx) => ({
    byIntegration: await tx.query<Record<string, unknown>>(
      `WITH runs AS (
         SELECT integration,
                count(*)::int AS runs,
                count(*) FILTER (WHERE status = 'success')::int AS success,
                count(*) FILTER (WHERE status = 'unchanged')::int AS unchanged,
                count(*) FILTER (WHERE status = 'error')::int AS error
           FROM noticeos.archive_runs
          GROUP BY integration
       ), objects AS (
         SELECT DISTINCT r.integration, o.object_seq, o.object_bytes AS bytes, o.first_stored_at AS first_at
           FROM noticeos.archive_runs r
           JOIN noticeos.archive_objects o ON o.workspace_id = r.workspace_id AND o.object_seq = r.object_seq
       ), totals AS (
         SELECT integration,
                count(*)::int AS objects,
                sum(bytes)::float8 AS bytes,
                count(*) FILTER (WHERE first_at >= $1::date)::int AS long_objects,
                COALESCE(sum(bytes) FILTER (WHERE first_at >= $1::date), 0)::float8 AS long_bytes
           FROM objects
          GROUP BY integration
       )
       SELECT r.integration, r.runs, r.success, r.unchanged, r.error,
              COALESCE(o.objects, 0) AS objects, COALESCE(o.bytes, 0) AS bytes,
              COALESCE(o.long_objects, 0) AS long_objects, COALESCE(o.long_bytes, 0) AS long_bytes
         FROM runs r LEFT JOIN totals o ON o.integration = r.integration
        ORDER BY r.integration COLLATE "C"`,
      [longSince],
    ),
    first: (await tx.query<{ first_at: string | null }>(`SELECT min(finished_at) AS first_at FROM noticeos.archive_runs`))[0],
  }));
  const days = observedDays(nowMs, longSince, first?.first_at ? javascriptInstant(first.first_at) : null);

  const integrations: ArchiveIntegrationCapacity[] = byIntegration.map((row) => ({
    integration: String(row.integration),
    runs: num(row.runs),
    success: num(row.success),
    unchanged: num(row.unchanged),
    error: num(row.error),
    objects: num(row.objects),
    objectBytes: num(row.bytes),
    newObjectsLongWindow: num(row.long_objects),
    newBytesLongWindow: num(row.long_bytes),
  }));
  const sum = (pick: (row: ArchiveIntegrationCapacity) => number) =>
    integrations.reduce((total, row) => total + pick(row), 0);

  return {
    manifests: {
      runs: sum((row) => row.runs),
      objects: sum((row) => row.objects),
      objectBytes: sum((row) => row.objectBytes),
      objectsPerDay: round(sum((row) => row.newObjectsLongWindow) / days),
      bytesPerDay: Math.round(sum((row) => row.newBytesLongWindow) / days),
      byIntegration: integrations,
    },
    bucket: singleWorkspace
      ? await listBucket(env.RAW_SIGNALS)
      : { error: 'Physical archive inventory requires a single-workspace store' },
  };
}

/** Group a key by what produced it, never by the site or day inside it:
 * `raw/<provider>/<integration>/…` and `checkpoints/<provider>/…`. */
function archivePrefix(key: string): string {
  const parts = key.split('/');
  return parts.slice(0, parts[0] === 'raw' ? 3 : 2).join('/');
}

async function listBucket(bucket: R2Bucket): Promise<ArchiveCapacity['bucket']> {
  try {
    const prefixes = new Map<string, { objects: number; bytes: number }>();
    let objects = 0;
    let bytes = 0;
    let cursor: string | undefined;
    let truncated = false;
    for (let page = 0; ; page += 1) {
      if (page >= CAPACITY_ARCHIVE_PAGE_LIMIT) {
        truncated = true;
        break;
      }
      const listed = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const object of listed.objects) {
        objects += 1;
        bytes += object.size;
        const prefix = archivePrefix(object.key);
        const entry = prefixes.get(prefix) ?? { objects: 0, bytes: 0 };
        entry.objects += 1;
        entry.bytes += object.size;
        prefixes.set(prefix, entry);
      }
      if (!listed.truncated) break;
      cursor = listed.cursor;
    }
    return {
      objects,
      bytes,
      truncated,
      byPrefix: [...prefixes.entries()]
        .map(([prefix, entry]) => ({ prefix, ...entry }))
        .sort((a, b) => b.bytes - a.bytes || a.prefix.localeCompare(b.prefix)),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function measureLanes(store: WorkspaceStore, longSince: string): Promise<LaneCapacity[]> {
  // Nearest-rank percentiles per lane, over the firings the runner recorded in
  // the long window: the closest measured stand-in for write and scan latency.
  // The rank is truncated, never rounded.
  const rows = await store.read((tx) =>
    tx.query<Record<string, unknown>>(
      `WITH d AS (
         SELECT job, outcome,
                extract(epoch FROM finished_at - started_at)::float8 * 1000 AS ms
           FROM noticeos.job_runs
          WHERE started_at >= $1::date
       ), r AS (
         SELECT job, outcome, ms,
                ROW_NUMBER() OVER (PARTITION BY job ORDER BY ms) AS rn,
                COUNT(*) OVER (PARTITION BY job) AS n
           FROM d
       )
       SELECT job,
              MAX(n)::int AS runs,
              count(*) FILTER (WHERE outcome = 'failed')::int AS failed,
              count(*) FILTER (WHERE outcome = 'skipped')::int AS skipped,
              MAX(CASE WHEN rn = trunc((n - 1) * 0.5) + 1 THEN ms END) AS p50,
              MAX(CASE WHEN rn = trunc((n - 1) * 0.95) + 1 THEN ms END) AS p95,
              MAX(ms) AS max_ms
         FROM r
        GROUP BY job
        ORDER BY job COLLATE "C"`,
      [longSince],
    ),
  );
  const ms = (value: unknown) => (value === null || value === undefined ? null : Math.round(num(value)));
  return rows.map((row) => ({
    job: String(row.job),
    runs: num(row.runs),
    failed: num(row.failed),
    skipped: num(row.skipped),
    p50Ms: ms(row.p50),
    p95Ms: ms(row.p95),
    maxMs: ms(row.max_ms),
  }));
}

/**
 * Measure the store. Read-only; every figure is a count, a byte total or an
 * arrival timestamp.
 */
export async function readCapacityInventory(
  env: Pick<IngestEnv, 'RAW_SIGNALS' | 'STORE'>,
  nowMs: number = Date.now(),
): Promise<CapacityInventory> {
  const shortSince = dayString(nowMs - CAPACITY_SHORT_DAYS * 86_400_000);
  const longSince = dayString(nowMs - CAPACITY_LONG_DAYS * 86_400_000);
  const { objects, bytes: storeBytes } = await listObjects(env.STORE);
  const tableNames = objects.filter((o) => o.type === 'table').map((o) => o.name).sort();
  const present = new Set(tableNames);

  const tables: TableCapacity[] = [];
  for (const object of objects.filter((o) => o.type === 'table')) {
    const { name, columns, bytes } = object;
    tables.push(
      await measureTable(env.STORE, name, columns, CATALOG[name], present, nowMs, shortSince, longSince, bytes),
    );
  }
  tables.sort((a, b) => b.valueBytes - a.valueBytes || a.name.localeCompare(b.name));

  const valueBytes = tables.reduce((sum, t) => sum + t.valueBytes, 0);
  const kept = tables.filter((t) => t.shape === 'history');
  return {
    generatedAt: new Date(nowMs).toISOString(),
    windows: {
      shortDays: CAPACITY_SHORT_DAYS,
      longDays: CAPACITY_LONG_DAYS,
      shortSince,
      longSince,
    },
    store: {
      bytes: storeBytes,
      valueBytes,
      unattributedBytes: storeBytes === null ? null : Math.max(0, storeBytes - valueBytes),
      tables: tableNames.length,
      views: objects.filter((o) => o.type === 'view').map((o) => o.name).sort(),
      missingTables: Object.keys(CATALOG).filter((name) => !present.has(name)).sort(),
      rows: tables.reduce((sum, t) => sum + t.rows, 0),
      historyRowsPerDay: round(kept.reduce((sum, t) => sum + (t.rowsPerDay ?? 0), 0)),
      historyBytesPerDay: kept.reduce((sum, t) => sum + (t.bytesPerDay ?? 0), 0),
      scanMs: tables.reduce((sum, t) => sum + t.scanMs, 0),
    },
    tables,
    // Missing summary tables are reported in the catalog readback, without
    // failing the rest of the inventory or inventing empty summaries.
    insightSnapshots: present.has('asset_insight_snapshots') ? await measureSnapshots(env.STORE, nowMs, longSince) : null,
    archive: present.has('archive_runs') && present.has('archive_objects')
      ? await measureArchive(env, nowMs, longSince, storeBytes !== null) : null,
    lanes: present.has('job_runs') ? await measureLanes(env.STORE, longSince) : null,
  };
}
