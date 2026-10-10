// The history files: how a generation is published, read and kept. A history
// folder holds Parquet datasets that DuckDB reads, published one complete
// generation at a time:
//
//   generations/00000007.json      one complete generation: every dataset, its
//                                  schema and the files that hold its rows
//   data/<dataset>/<period>/<fingerprint>.parquet
//                                  a file is never rewritten; a later
//                                  generation names a new file instead
//   .lock                          held while a run writes or removes
//
// These are the pieces every writer of that folder shares, so there is one
// manifest format and one set of rules:
//
//   * A data file's name is a hash of exactly the rows it holds (with its
//     dataset, period, schema and derivation), so a file is written once and a
//     run that finds it already there writes nothing (`writePeriod`).
//   * A generation's files are written first and its manifest last, by an
//     exclusive link, so the highest-numbered manifest names only complete
//     files, and a racing run fails rather than publish over another
//     (`publishManifest`).
//   * A schema is its columns and their types, and its id their hash
//     (`schemaOf`); a derivation id hashes the files that decide what a row
//     is (`derivationFrom`).
//   * One run at a time holds the folder's lock; a lock whose process is gone
//     is taken over (`holdLock`).
//   * Every generation published in the last KEEP_GENERATIONS_DAYS days, and
//     the newest, is kept; the rest are removed, manifests first, then every
//     data file no kept manifest names (`keptGenerations`, `pruneHistory`).
//
// scripts/signal-history.mjs (`pnpm signals:history`) writes the provider
// archive as `asset`, `derivation`, `sources` and `datasets`. It also preserves
// existing `tables` datasets created during the completed database transition:
// rows beyond Postgres's retention windows, with a derivation per table. Such
// a generation can name no site yet (`asset` null, no sources).
//
// Readers take the highest-numbered manifest and give DuckDB the files it
// lists (`datasetFiles`, `tableFiles`), never a glob of data/.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOLEAN, DOUBLE, DuckDBDataChunk, VARCHAR } from '@duckdb/node-api';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const HISTORY_FORMAT = 'noticeos-signal-history/1';

/**
 * How long the history keeps a generation: every one published in the last
 * 30 days, and the newest whatever its age. Readers only ever need the
 * newest; 30 days lets a report be re-run on the generation it was built
 * from.
 */
export const KEEP_GENERATIONS_DAYS = 30;

/** That rule, in the words a refusal quotes. */
export const RETENTION = `every generation published in the last ${KEEP_GENERATIONS_DAYS} days, and the newest`;

const DAY_MS = 86_400_000;
/** The file a run holds while it writes or removes. */
export const LOCK = '.lock';
const MANIFEST = /^\d{8}\.json$/;
/** What a run that died can leave: a manifest or a data file half-written. */
const MANIFEST_TEMPORARY = /^\.\d{8}\.json\.\d+\.[0-9a-f]{8}\.tmp$/;
const DATA_FILE = /^[0-9a-f]{32}\.parquet$/;
const DATA_TEMPORARY = /^\.[0-9a-f]{32}\.\d+\.[0-9a-f]{8}\.tmp$/;

const DUCKDB_TYPES = { DOUBLE, BOOLEAN, VARCHAR };
/** DuckDB's vector size: the most rows one appended chunk holds. */
const CHUNK_ROWS = 2048;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function schemaOf(columns) {
  return { id: sha256(JSON.stringify(columns)).slice(0, 16), columns };
}

export function generationFile(generation) {
  return `${String(generation).padStart(8, '0')}.json`;
}

/** A dataset's folder: its name, or a hash of it when the name is not a plain
 * path segment (a report name is whatever the archive says). */
export function datasetFolder(name) {
  return /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : `dataset-${sha256(name).slice(0, 16)}`;
}

export function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function sqlName(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

/**
 * The files (paths under the repository) whose text decides what a published
 * row is, hashed, with `fields` that decide it too: `{ id, ...fields, files }`.
 * A change to any of them is a new derivation.
 */
export async function derivationFrom(relatives, fields = {}) {
  const files = {};
  for (const relative of relatives) files[relative] = sha256(await fs.readFile(path.join(REPO_ROOT, relative)));
  return { id: sha256(JSON.stringify({ format: HISTORY_FORMAT, ...fields, files })).slice(0, 16), ...fields, files };
}

/** The numbers of the generations `output` lists, oldest first. */
export async function listGenerations(output) {
  let names;
  try {
    names = await fs.readdir(path.join(output, 'generations'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => MANIFEST.test(name)).map((name) => Number(name.slice(0, 8))).sort((left, right) => left - right);
}

/** The generation readers see now — the highest-numbered manifest — or null. */
export async function readCurrentGeneration(output) {
  for (let attempt = 1; ; attempt++) {
    const numbers = await listGenerations(output);
    if (numbers.length === 0) return null;
    try {
      return await readGeneration(output, numbers.at(-1));
    } catch (error) {
      // The newest is never removed, so the one listed went because a newer
      // one was published since: list again.
      if (error?.code !== 'ENOENT' || attempt === 3) throw error;
    }
  }
}

/**
 * The generations the history keeps at `now` (KEEP_GENERATIONS_DAYS), oldest
 * first, of `generations` — manifests, or anything with their `generation` and
 * `publishedAt`. A generation whose time cannot be read is never judged old.
 */
export function keptGenerations(generations, now) {
  const cutoff = Date.parse(now) - KEEP_GENERATIONS_DAYS * DAY_MS;
  if (!Number.isFinite(cutoff)) throw new Error(`${now} is not a time.`);
  const newest = Math.max(...generations.map(({ generation }) => generation));
  return generations
    .filter(({ generation, publishedAt }) => {
      const at = Date.parse(publishedAt);
      return generation === newest || !Number.isFinite(at) || at > cutoff;
    })
    .map(({ generation }) => generation)
    .sort((left, right) => left - right);
}

/** One published generation's manifest. */
export async function readGeneration(output, generation) {
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'generations', generationFile(generation)), 'utf8'));
  if (manifest?.format !== HISTORY_FORMAT || manifest.generation !== generation) {
    throw new Error(`generations/${generationFile(generation)} is not a ${HISTORY_FORMAT} manifest for generation ${generation}.`);
  }
  return manifest;
}

/** The absolute paths of a dataset's files in one generation, in order;
 * `sources` names the register. */
export function datasetFiles(output, manifest, name) {
  const dataset = name === 'sources' ? manifest.sources : manifest.datasets.find((entry) => entry.name === name);
  if (!dataset) throw new Error(`Generation ${manifest.generation} has no dataset ${name}.`);
  return dataset.files.map((file) => path.join(output, file.path));
}

/** The absolute paths of a table dataset's files in one generation, in order. */
export function tableFiles(output, manifest, name) {
  const dataset = manifest.tables?.datasets.find((entry) => entry.name === name);
  if (!dataset) throw new Error(`Generation ${manifest.generation} has no table dataset ${name}.`);
  return dataset.files.map((file) => path.join(output, file.path));
}

/** What a generation holds, without when or how it was written: equal for an
 * incremental run and a rebuild of one archive. */
export function contentOf(manifest) {
  const files = (list) => list.map(({ partition, fingerprint, rows, inputsFingerprint, firstReportDate, lastReportDate }) => ({
    partition, fingerprint, rows, inputsFingerprint, firstReportDate, lastReportDate,
  }));
  const { tables } = manifest;
  return sha256(JSON.stringify({
    format: manifest.format,
    asset: manifest.asset,
    derivation: manifest.derivation?.id ?? null,
    downloadsManifest: manifest.downloadsManifest,
    sources: manifest.sources ? { schema: manifest.sources.schema.id, rows: manifest.sources.rows, files: files(manifest.sources.files) } : null,
    datasets: manifest.datasets.map((dataset) => ({
      name: dataset.name,
      schema: dataset.schema.id,
      rowOrder: dataset.rowOrder,
      rows: dataset.rows,
      files: files(dataset.files),
    })),
    ...(tables ? {
      tables: {
        workspaceId: tables.workspaceId,
        backup: tables.backup.sha256,
        asOf: tables.asOf,
        derivation: tables.derivation.id,
        datasets: tables.datasets.map((dataset) => ({
          name: dataset.name,
          table: dataset.table,
          schema: dataset.schema.id,
          rowOrder: dataset.rowOrder,
          rows: dataset.rows,
          digest: dataset.digest,
          exportedThrough: dataset.exportedThrough,
          files: files(dataset.files),
        })),
      },
    } : {}),
  }));
}

/** Every file a generation names: the register's, the archive datasets' and the table datasets'. */
function namedFiles(manifest) {
  return [manifest.sources, ...manifest.datasets, ...(manifest.tables?.datasets ?? [])]
    .filter(Boolean)
    .flatMap((dataset) => dataset.files);
}

/** How a filled table becomes a Parquet file: zstd, with the dataset, schema,
 * derivation and fingerprint in the file's own metadata. */
export async function copyToParquet(connection, table, target, metadata) {
  const pairs = Object.entries(metadata).map(([key, value]) => `${key}: ${sqlString(value)}`).join(', ');
  await connection.run(`COPY ${sqlName(table)} TO ${sqlString(target)} (FORMAT parquet, COMPRESSION zstd, KV_METADATA {${pairs}})`);
}

async function fileDigest(file) {
  const bytes = await fs.readFile(file);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

/**
 * Write one dataset period from `batches` of rows. `encode(row)` gives a row's
 * values in `schema`'s column order, as its columns store them; the values are
 * hashed and appended to a DuckDB table, and the file's name is that hash, so a
 * period whose rows a file already holds is not written again. `dayOf(row)` is
 * the day a row is dated, and `compareDays` their order: the file records its
 * first and last. A new file is copied to a temporary name, flushed to disk and
 * renamed into place, under data/<folder>/<partition>/ (the dataset's folder
 * unless the writer names one). A column of a type the appender does not take
 * (BIGINT, DATE, TIMESTAMPTZ, DECIMAL …) is given as its text and cast when
 * the file is written.
 */
export async function writePeriod(context, { dataset, folder = datasetFolder(dataset), partition, schema, batches, inputsFingerprint, encode, dayOf, compareDays }) {
  const { connection, output, derivation, writeFile, written } = context;
  const table = `period_${written.tables++}`;
  const columns = schema.columns;
  const staged = columns.map(([name, type]) => [name, DUCKDB_TYPES[type] ? type : 'VARCHAR']);
  await connection.run(`CREATE TABLE ${sqlName(table)} (${staged.map(([name, type]) => `${sqlName(name)} ${type}`).join(', ')})`);
  const appender = await connection.createAppender(table);
  const types = staged.map(([, type]) => DUCKDB_TYPES[type]);
  const hash = createHash('sha256').update(JSON.stringify([dataset, partition, schema.id, derivation.id]));
  let rows = 0;
  let first = null;
  let last = null;
  let pending = columns.map(() => []);
  const flush = () => {
    if (pending[0].length === 0) return;
    const chunk = DuckDBDataChunk.create(types, pending[0].length);
    chunk.setColumns(pending);
    appender.appendDataChunk(chunk);
    pending = columns.map(() => []);
  };
  try {
    for await (const batch of batches) {
      for (const row of batch) {
        const values = encode(row);
        hash.update(`\n${JSON.stringify(values)}`);
        values.forEach((value, index) => pending[index].push(value));
        if (pending[0].length === CHUNK_ROWS) flush();
        rows += 1;
        const day = dayOf(row);
        if (first === null || compareDays(day, first) < 0) first = day;
        if (last === null || compareDays(day, last) > 0) last = day;
      }
    }
    flush();
  } finally {
    appender.closeSync();
  }
  const fingerprint = hash.digest('hex').slice(0, 32);
  const relative = `data/${folder}/${partition}/${fingerprint}.parquet`;
  const target = path.join(output, relative);
  let typed = table;
  if (staged.some(([, type], index) => type !== columns[index][1])) {
    typed = `${table}_typed`;
    await connection.run(`CREATE TABLE ${sqlName(typed)} AS SELECT ${columns.map(([name, type]) => `CAST(${sqlName(name)} AS ${type}) AS ${sqlName(name)}`).join(', ')} FROM ${sqlName(table)}`);
  }
  if (!(await exists(target))) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), `.${fingerprint}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await writeFile(connection, typed, temporary, {
        noticeos_dataset: dataset,
        noticeos_schema_id: schema.id,
        noticeos_derivation_id: derivation.id,
        noticeos_fingerprint: fingerprint,
      });
      const handle = await fs.open(temporary, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    written.files.push(relative);
  }
  await connection.run(`DROP TABLE ${sqlName(table)}`);
  if (typed !== table) await connection.run(`DROP TABLE ${sqlName(typed)}`);
  return {
    path: relative,
    partition,
    rows,
    firstReportDate: first,
    lastReportDate: last,
    inputsFingerprint,
    fingerprint,
    ...(await fileDigest(target)),
  };
}

/** Publish a generation's manifest by an exclusive link: it appears whole, and
 * never over another run's. */
export async function publishManifest(output, manifest) {
  const folder = path.join(output, 'generations');
  await fs.mkdir(folder, { recursive: true });
  const name = generationFile(manifest.generation);
  const temporary = path.join(folder, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const handle = await fs.open(temporary, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temporary, path.join(folder, name));
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`Another run published generation ${manifest.generation} first; nothing this run wrote is visible. Run again.`);
    }
    throw error;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Hold `file` as one process's lock. It appears whole, by an exclusive link,
 * holding this process's id; a lock whose process is gone is taken over.
 * Contenders publish unique reservations before inspecting the shared lock.
 * Reclaiming requires no other live contender, so a stale read cannot remove
 * another contender's newly acquired lock. Simultaneous reclaims may both
 * decline; the existing completed generation remains available.
 * Returns the release. `busy(holder)` is the error to throw when a live
 * process holds it, or — `holder` null — when another took it first.
 */
export async function holdLock(file, busy) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ pid: process.pid, since: new Date().toISOString() })}\n`, { flag: 'wx' });
  try {
    const prefix = `${path.basename(file)}.`;
    const contenders = [];
    for (const name of await fs.readdir(path.dirname(file))) {
      if (!name.startsWith(prefix)) continue;
      const match = /^(\d+)\.[0-9a-f]{8}\.tmp$/u.exec(name.slice(prefix.length));
      if (!match) continue;
      const candidate = path.join(path.dirname(file), name);
      if (candidate === temporary) continue;
      const pid = Number(match[1]);
      if (alive(pid)) contenders.push(pid);
      else await fs.rm(candidate, { force: true });
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.link(temporary, file);
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          await fs.rm(file, { force: true });
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      let holder = null;
      try {
        holder = JSON.parse(await fs.readFile(file, 'utf8')).pid;
      } catch {
        holder = null;
      }
      if (Number.isInteger(holder) && alive(holder)) throw busy(holder);
      if (contenders.length) throw busy(contenders[0]);
      // Its owner is gone: whatever it left is not being written any more.
      await fs.rm(file, { force: true });
    }
    throw busy(null);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Remove what the history at `output` no longer keeps at `now`, under the
 * history's lock, which the caller holds: the manifests of the generations it
 * no longer keeps, oldest first; then every data file no kept manifest names,
 * and the half-written files of a run that died. Only the writer's own names
 * under generations/ and data/<dataset>/<period>/ are candidates, and a folder
 * is removed only when empty. `beforeRemove(relative)` sees each removal before
 * it happens (tests interrupt the prune with it).
 */
export async function pruneHistory(output, now, beforeRemove) {
  const manifests = [];
  for (const generation of await listGenerations(output)) {
    try {
      manifests.push(await readGeneration(output, generation));
    } catch (error) {
      throw new Error(`generations/${generationFile(generation)} cannot be read (${error instanceof Error ? error.message : String(error)}), so which files it names is unknown and nothing was removed`);
    }
  }
  const kept = new Set(keptGenerations(manifests, now));
  const removed = { generations: [], files: 0 };
  const remove = async (relative, how) => {
    await beforeRemove?.(relative);
    await how(path.join(output, ...relative.split('/')));
  };
  // A generation no reader can pin before any file of it goes.
  for (const manifest of manifests) {
    if (kept.has(manifest.generation)) continue;
    await remove(`generations/${generationFile(manifest.generation)}`, fs.unlink);
    removed.generations.push(manifest.generation);
  }
  const listing = async (relative) => {
    try {
      return (await fs.readdir(path.join(output, ...relative.split('/')), { withFileTypes: true }))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  };
  for (const entry of await listing('generations')) {
    if (!entry.isFile() || !MANIFEST_TEMPORARY.test(entry.name)) continue;
    await remove(`generations/${entry.name}`, fs.unlink);
    removed.files += 1;
  }
  const named = new Set(manifests
    .filter((manifest) => kept.has(manifest.generation))
    .flatMap((manifest) => namedFiles(manifest).map((file) => file.path)));
  for (const dataset of await listing('data')) {
    if (!dataset.isDirectory()) continue;
    for (const period of await listing(`data/${dataset.name}`)) {
      if (!period.isDirectory()) continue;
      const folder = `data/${dataset.name}/${period.name}`;
      for (const entry of await listing(folder)) {
        const relative = `${folder}/${entry.name}`;
        if (!entry.isFile()) continue;
        if ((DATA_FILE.test(entry.name) && !named.has(relative)) || DATA_TEMPORARY.test(entry.name)) {
          await remove(relative, fs.unlink);
          removed.files += 1;
        }
      }
      if ((await listing(folder)).length === 0) await remove(folder, fs.rmdir);
    }
    if ((await listing(`data/${dataset.name}`)).length === 0) await remove(`data/${dataset.name}`, fs.rmdir);
  }
  return { keptGenerations: [...kept], removedGenerations: removed.generations, removedFiles: removed.files };
}
