// The config store: where a setting is read from, and the one door it is
// written through. The store holds each config file as a whole JSON document
// keyed by its file's name, and this module is the only thing in either Worker
// that reads or writes one. The files are still the seed (`pnpm config:seed`)
// and the export (`pnpm config:export`); every read falls back to the copy
// compiled into this Worker, so an install whose store holds no document
// behaves exactly as one before the store did. Whole documents, not typed
// tables: the changeset vocabulary is RFC-6901 pointers into one, and the
// pipeline is imported from scripts/config-documents.mjs, which is plain ESM
// so it bundles here. A store that fails is an error, never a fallback, and a
// write never degrades.

import { javascriptInstant, type WorkspaceStore } from '@noticeos/postgres';
import type {
  ChangesetOp,
  JsonValue,
  Mismatch,
} from '../../../scripts/config-documents.mjs';
import {
  CONFIG_DOCUMENT_FILES,
  ChangesetError,
  MISSING,
  applyDocumentOps,
  configDocumentFile,
  configDocumentKey,
  resolveOps,
  serializeDocument,
  validateSchemaAndSafety,
} from '../../../scripts/config-documents.mjs';

// The compiled fallback excludes the coordination document and reads no
// installation files.
import { collectorDefaultDocument } from '../../../scripts/config-defaults.mjs';
import { isRecord } from './shared.js';

/** Every file the store may hold a document for. Derived from the register
 * declarations, so a new register is storable without a code change here. */
export { CONFIG_DOCUMENT_FILES };

import type { ConfigSource, ConfigDocumentRead, ApplyConfigOpsInput, ConfigWriteMismatch, ApplyConfigOpsResult } from '@noticeos/contract/configuration';
import { isolateState } from './isolate-state.js';
export type { ConfigSource, ConfigDocumentRead, ApplyConfigOpsInput, ConfigWriteMismatch, ApplyConfigOpsResult } from '@noticeos/contract/configuration';

/** One stored document as this module hands it on: named by its file, its
 * instants as JavaScript writes them. */
interface StoredRow {
  file: string;
  body_json: string;
  version: number;
  updated_at: string;
  updated_by: string | null;
}

/** One config_documents row as the store answers it (the body is the json
 * column's own text, byte for byte). */
type DocumentRow = {
  document_key: string;
  body: string;
  version: number;
  updated_at: string;
  updated_by: string | null;
};

const storedRow = (row: DocumentRow): StoredRow => ({
  file: configDocumentFile(row.document_key),
  body_json: row.body,
  version: row.version,
  updated_at: javascriptInstant(row.updated_at),
  updated_by: row.updated_by,
});

/** The store's key for a file this module may hold (CONFIG_DOCUMENT_FILES). */
function keyOf(file: string): string {
  const key = configDocumentKey(file);
  if (key === null) throw new Error(`${file} is not a config document the store can hold`);
  return key;
}

// ---------------------------------------------------------------------------
// The read cache
// ---------------------------------------------------------------------------
//
// One second, invalidated on every write from this isolate. A config read is
// per request: one Wall poll resolves a dozen documents several times a minute.
// One second is shorter than anything that reads a value back after writing it
// (`useConfigSave` waits 1500ms before invalidating), so a Save is never read
// back stale even in the isolate that did not perform it.

const CACHE_MS = 1000;
type DocumentCache = Map<string, { at: number; row: StoredRow | null }>;
// The store and the workspace are the cache key: one isolate serves many
// calls, and two workspaces or two stores must never share an answer.
let caches = new Map<string, DocumentCache>();

/** Invalidate what was cached from `store` after a write to it; omit it to reset all tests. */
export function forgetConfigCache(store?: WorkspaceStore): void {
  if (!store) {
    caches = new Map();
    return;
  }
  for (const key of caches.keys()) if (key.startsWith(`${store.where}\n`)) caches.delete(key);
}
isolateState('config-store read cache', { forget: () => forgetConfigCache(), held: () => caches.size > 0 });

async function readRows(store: WorkspaceStore, files: string[]): Promise<Map<string, StoredRow | null>> {
  const out = new Map<string, StoredRow | null>();
  const cacheKey = `${store.where}\n${await store.workspaceId()}`;
  let cache = caches.get(cacheKey);
  if (!cache) {
    cache = new Map();
    caches.set(cacheKey, cache);
  }
  const now = Date.now();
  const wanted: string[] = [];
  for (const file of files) {
    const hit = cache.get(file);
    if (hit !== undefined && now - hit.at < CACHE_MS) out.set(file, hit.row);
    else wanted.push(file);
  }
  if (wanted.length === 0) return out;
  const rows = await store.read((tx) =>
    tx.query<DocumentRow>(
      `SELECT document_key, body, version, updated_at, updated_by
         FROM noticeos.config_documents
        WHERE document_key = ANY($1::text[])`,
      [wanted.map(keyOf)],
    ),
  );
  const byFile = new Map(rows.map((row) => [configDocumentFile(row.document_key), storedRow(row)]));
  for (const file of wanted) {
    const row = byFile.get(file) ?? null;
    cache.set(file, { at: now, row });
    out.set(file, row);
  }
  return out;
}

/** A stored row's document, or null when its JSON does not parse: a corrupted
 * row answers the compiled file plus a log line rather than taking every page
 * down over one bad character. */
function parseBody(row: StoredRow): JsonValue | null {
  try {
    return JSON.parse(row.body_json) as JsonValue;
  } catch {
    console.warn(`config_documents ${row.file} v${row.version} does not parse — using the file`);
    return null;
  }
}

/**
 * The compiled copy of one file: a copy, never the module object itself.
 * `applyDocumentOps` mutates the document it is given, so handing back the
 * module object would let a first save on an unseeded install edit the
 * Worker's own compiled config in memory, visible for the rest of the
 * isolate's life whenever the write did not land.
 */
function bundled(file: string): JsonValue | null {
  return collectorDefaultDocument(file);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Several documents in one round trip. */
export async function getConfigDocuments(
  env: Pick<IngestEnv, 'STORE'>,
  files: readonly string[],
): Promise<ConfigDocumentRead[]> {
  const known = files.filter((file) => CONFIG_DOCUMENT_FILES.includes(file));
  const rows = await readRows(env.STORE, known);
  return files.map((file) => {
    const row = known.includes(file) ? (rows.get(file) ?? null) : null;
    const stored = row === null ? null : parseBody(row);
    if (row !== null && stored !== null) {
      return {
        file,
        body: stored,
        source: 'store' as const,
        version: row.version,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      };
    }
    return {
      file,
      body: bundled(file),
      source: 'file' as const,
      version: null,
      updatedAt: null,
      updatedBy: null,
    };
  });
}

/** One document, store-first. */
export async function getConfigDocument(
  env: IngestEnv,
  file: string,
): Promise<ConfigDocumentRead> {
  const [read] = await getConfigDocuments(env, [file]);
  // A one-element input always answers a one-element output; the fallback
  // keeps the type honest.
  return (
    read ?? {
      file,
      body: null,
      source: 'file',
      version: null,
      updatedAt: null,
      updatedBy: null,
    }
  );
}

/** Which files the store holds, in file order. */
export async function listConfigDocuments(env: IngestEnv): Promise<{
  documents: { file: string; version: number; updatedAt: string; updatedBy: string | null }[];
}> {
  const rows = await env.STORE.read((tx) =>
    tx.query<DocumentRow>('SELECT document_key, body, version, updated_at, updated_by FROM noticeos.config_documents'),
  );
  return {
    documents: rows
      .map(storedRow)
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
      .map((row) => ({ file: row.file, version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by })),
  };
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

/** A document moved since this write read it: the write's transaction rolls back. */
class StaleVersions extends Error {
  override name = 'StaleVersions';
}

/** MISSING is a symbol and does not survive an RPC boundary, so an absent
 * value says so in a field of its own. */
function serializeMismatch(m: Mismatch): ConfigWriteMismatch {
  const where =
    m.op.kind === 'store-asset-set'
      ? { asset: m.op.asset, column: m.op.column }
      : { file: m.op.file, pointer: m.op.pointer };
  const expectAbsent = m.expect === MISSING;
  return {
    ...where,
    expect: expectAbsent ? null : (m.expect as JsonValue),
    ...(expectAbsent ? { expectAbsent: true as const } : {}),
    current: m.current === MISSING ? null : (m.current as JsonValue),
    absent: m.current === MISSING,
  };
}

/**
 * Apply one changeset to the stored documents, and record what it did. Every
 * step refuses before anything is written: validate against the declarations,
 * read the named documents, check each file's version against the one the
 * caller read, resolve every op's `expect`, apply, then write all documents
 * behind one version guard with their audit rows in the same transaction.
 *
 * A document the store does not hold yet is seeded by this write from the
 * compiled copy (`version_before = 0`), so a freshly deployed Tower can save a
 * setting; the `expect` guard is checked against the same compiled document
 * the browser rendered.
 */
export async function applyConfigOps(
  env: IngestEnv,
  input: ApplyConfigOpsInput,
  nowMs: number = Date.now(),
): Promise<ApplyConfigOpsResult> {
  const ops = Array.isArray(input?.ops) ? input.ops : [];
  const actor = typeof input?.actor === 'string' && input.actor.trim() !== '' ? input.actor.trim() : '';
  if (actor === '') {
    return { ok: false, error: 'invalid_changeset', detail: 'a config change must name its actor' };
  }
  // An asset's stage, automation mode or name is a store column with its own
  // route. Refused by name rather than ignored, in the dev lane's own words.
  if (ops.some((op) => (op as { kind?: unknown } | null)?.kind === 'store-asset-set')) {
    return { ok: false, error: 'store_op_not_accepted', detail: 'Store columns save through PATCH /api/assets/:id' };
  }

  const at = new Date(nowMs).toISOString();
  const changeset = {
    version: 1 as const,
    slug: typeof input.slug === 'string' && input.slug !== '' ? input.slug : 'config-change',
    createdAt: at,
    ops,
  };
  try {
    validateSchemaAndSafety(changeset);
  } catch (err) {
    if (err instanceof ChangesetError) {
      return { ok: false, error: 'invalid_changeset', detail: err.message };
    }
    throw err;
  }

  // Every file the ops name, plus the roster the cross-file rules read.
  const named = [...new Set(ops.map((op) => (op as { file?: string }).file ?? ''))].filter(
    (file) => file !== '',
  );
  const reads = await getConfigDocuments(env, [...new Set([...named, 'config/integrations.json'])]);
  const byFile = new Map(reads.map((read) => [read.file, read]));

  // Neither the store nor this deployment holds the file: the state, the files
  // and the command that seeds them.
  const unseedable = named.filter((file) => (byFile.get(file)?.body ?? null) === null);
  if (unseedable.length > 0) {
    return {
      ok: false,
      error: 'not_seeded',
      detail: `Not seeded · ${unseedable.join(', ')} · pnpm config:seed`,
      files: unseedable,
    };
  }

  const expectVersions = input.expectVersions ?? {};
  const versionMismatches = named
    .map((file) => {
      const read = byFile.get(file);
      const expected = expectVersions[file];
      const observed = read?.version ?? 0;
      if (typeof expected !== 'number' || expected === observed) return null;
      return { file, expected, observed };
    })
    .filter((row): row is { file: string; expected: number; observed: number } => row !== null);
  if (versionMismatches.length > 0) {
    return { ok: false, error: 'version_mismatch', files: versionMismatches };
  }

  let resolved;
  let documents;
  let mismatches;
  try {
    ({ resolved, mismatches, documents } = await resolveOps(changeset, null, {
      readDocument: async (file: string) => byFile.get(file)?.body ?? null,
      // A key the stored document lacks is what the page showed from the
      // compiled copy.
      readBuiltIn: async (file: string) => bundled(file),
    }));
  } catch (err) {
    if (err instanceof ChangesetError) {
      return { ok: false, error: 'invalid_changeset', detail: err.message };
    }
    throw err;
  }
  if (mismatches.length > 0) {
    return { ok: false, error: 'expect_mismatch', mismatches: mismatches.map(serializeMismatch) };
  }

  // `at` is this changeset's own instant, which `config_changes` also records,
  // so a date the write stamps into a document names the same day the audit
  // row does.
  let touched: string[];
  try {
    touched = applyDocumentOps(resolved, documents, { at });
  } catch (err) {
    if (err instanceof ChangesetError) {
      return { ok: false, error: 'invalid_changeset', detail: err.message };
    }
    throw err;
  }
  const rows = touched.map((file) => {
    const before = byFile.get(file)?.version ?? 0;
    return {
      file,
      before,
      after: before + 1,
      body_json: serializeDocument(documents.get(file) as JsonValue),
      ops_json: JSON.stringify(ops.filter((op) => (op as { file?: string }).file === file)),
    };
  });
  // One transaction for the whole changeset. Each document is written only if
  // the store still holds the version this write started from (a missing
  // document is version 0, so a concurrent first seed is a competing save), and
  // any row it did not write rolls the whole changeset back.
  let landed = true;
  try {
    await env.STORE.write(async (tx) => {
      const changed = await tx.execute(
        `INSERT INTO noticeos.config_documents AS d (workspace_id, document_key, body, version, updated_at, updated_by)
         SELECT $1::uuid, p.document_key, p.body::json, p.version_after, $5::timestamptz, $6::text
           FROM unnest($2::text[], $3::text[], $4::int[]) AS p(document_key, body, version_after)
         ON CONFLICT (workspace_id, document_key) DO UPDATE
            SET body = excluded.body, version = excluded.version,
                updated_at = excluded.updated_at, updated_by = excluded.updated_by
          WHERE d.version = excluded.version - 1`,
        [tx.workspaceId, rows.map((row) => keyOf(row.file)), rows.map((row) => row.body_json), rows.map((row) => row.after), at, actor],
      );
      if (changed !== rows.length) throw new StaleVersions();
      await tx.execute(
        `INSERT INTO noticeos.config_changes
           (workspace_id, document_key, ops, reason, actor, version_before, version_after, changed_at)
         SELECT $1::uuid, c.document_key, c.ops::jsonb, $5::text, $6::text, c.version_before, c.version_after, $7::timestamptz
           FROM unnest($2::text[], $3::text[], $4::int[], $8::int[]) AS c(document_key, ops, version_before, version_after)`,
        [
          tx.workspaceId,
          rows.map((row) => keyOf(row.file)),
          rows.map((row) => row.ops_json),
          rows.map((row) => row.before),
          input.reason ?? null,
          actor,
          at,
          rows.map((row) => row.after),
        ],
      );
    });
  } catch (error) {
    if (!(error instanceof StaleVersions)) throw error;
    landed = false;
  }
  forgetConfigCache(env.STORE);

  if (!landed) {
    const now = await getConfigDocuments(env, touched);
    return {
      ok: false,
      error: 'version_mismatch',
      files: now.filter((read) => (read.version ?? 0) !== (byFile.get(read.file)?.version ?? 0))
        .map((read) => ({
          file: read.file,
          expected: expectVersions[read.file] ?? byFile.get(read.file)?.version ?? 0,
          observed: read.version ?? 0,
        })),
    };
  }
  const written = rows.map((row) => ({
    file: row.file, version: row.after, body: documents.get(row.file),
  }));

  return { ok: true, applied: ops.length, documents: written };
}

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

export interface SeedConfigDocumentsInput {
  /** file → the document as the checkout holds it. */
  documents: Record<string, unknown>;
  actor: string;
  /** Re-seed a document that is already there. Every forced file needs a reason. */
  force?: string[];
  reason?: string | null;
}

export interface SeedConfigDocumentsResult {
  ok: boolean;
  error?: string;
  detail?: string;
  seeded: { file: string; version: number }[];
  skipped: { file: string; version: number }[];
  refused: { file: string; detail: string }[];
}

/**
 * Load documents the store does not have yet. Never an overwrite: a file already
 * in the store is reported as skipped with its version, so running the seed
 * after months of Saves cannot undo the operator's settings. `--force <file>
 * --reason <why>` is the deliberate way past it, and records a `config_changes`
 * row like any other change.
 */
export async function seedConfigDocuments(
  env: IngestEnv,
  input: SeedConfigDocumentsInput,
  nowMs: number = Date.now(),
): Promise<SeedConfigDocumentsResult> {
  const actor = typeof input?.actor === 'string' && input.actor.trim() !== '' ? input.actor.trim() : '';
  if (actor === '') {
    return {
      ok: false,
      error: 'invalid_request',
      detail: 'a seed must name its actor',
      seeded: [],
      skipped: [],
      refused: [],
    };
  }

  const at = new Date(nowMs).toISOString();
  const force = new Set(input.force ?? []);
  const files = Object.keys(input.documents ?? {});
  const seeded: { file: string; version: number }[] = [];
  const skipped: { file: string; version: number }[] = [];
  const refused: { file: string; detail: string }[] = [];

  forgetConfigCache(env.STORE);
  for (const file of files) {
    if (!CONFIG_DOCUMENT_FILES.includes(file)) {
      refused.push({ file, detail: 'not a config document this OS knows how to edit' });
      continue;
    }
    if (force.has(file) && (input.reason ?? '').trim() === '') {
      refused.push({ file, detail: 'a forced re-seed needs a reason' });
      continue;
    }
    const body = input.documents[file];
    if (body === undefined || body === null || typeof body !== 'object') {
      refused.push({ file, detail: 'a config document must be a JSON object or array' });
      continue;
    }
    const key = keyOf(file);
    const bodyJson = serializeDocument(body);
    // One transaction per document: what is there, then the document and its
    // audit row together.
    const outcome = await env.STORE.write(async (tx) => {
      const [existing] = await tx.query<{ version: number }>(
        'SELECT version FROM noticeos.config_documents WHERE document_key = $1',
        [key],
      );
      if (existing !== undefined && !force.has(file)) return { seeded: false, version: existing.version };
      const before = existing?.version ?? 0;
      const after = before + 1;
      if (before === 0) {
        await tx.execute(
          `INSERT INTO noticeos.config_documents (workspace_id, document_key, body, version, updated_at, updated_by)
           VALUES ($1::uuid, $2, $3::json, 1, $4::timestamptz, $5)`,
          [tx.workspaceId, key, bodyJson, at, actor],
        );
      } else {
        await tx.execute(
          `UPDATE noticeos.config_documents
              SET body = $1::json, version = $2, updated_at = $3::timestamptz, updated_by = $4
            WHERE document_key = $5`,
          [bodyJson, after, at, actor, key],
        );
      }
      await tx.execute(
        `INSERT INTO noticeos.config_changes
           (workspace_id, document_key, ops, reason, actor, version_before, version_after, changed_at)
         VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6, $7, $8::timestamptz)`,
        [tx.workspaceId, key, JSON.stringify([{ kind: 'document-seed', file }]), input.reason ?? null, actor, before, after, at],
      );
      return { seeded: true, version: after };
    });
    (outcome.seeded ? seeded : skipped).push({ file, version: outcome.version });
  }
  forgetConfigCache(env.STORE);

  return { ok: refused.length === 0, seeded, skipped, refused };
}

// ---------------------------------------------------------------------------
// What this Worker's own collectors read
// ---------------------------------------------------------------------------
//
// One reader, one round trip, one fallback rule. Every config document a
// collector needs is resolved here, once per cron fire, and handed to each
// lane as a parameter, which is what lets a suite state its own mapping. A
// document the store does not hold, or holds in a shape its readers cannot
// use, answers `undefined`, which means keep the compiled copy. The shape
// check is deliberately shallow: a collector that stopped over one malformed
// key would be worse than a stale document.

/** The documents this Worker's own collectors resolve store-first. */
export const COLLECTOR_CONFIG_FILES = [
  'config/pull.json',
  'config/counters.json',
  'config/integrations.json',
  'config/ga4-custom-dimensions.json',
  'config/serp-panel.json',
  'config/constants.json',
] as const;

export type CollectorConfigFile = (typeof COLLECTOR_CONFIG_FILES)[number];

/**
 * Per file, which of the two answered on this run. The word only: a
 * completion line never carries a document.
 */
export type ConfigSourceMap = Readonly<Partial<Record<CollectorConfigFile, ConfigSource>>>;

export interface CollectorConfigs {
  /** Per file: the stored document, or `undefined` to keep the compiled copy. */
  documents: Readonly<Partial<Record<CollectorConfigFile, unknown>>>;
  sources: ConfigSourceMap;
}

/** Whether a stored document is the shape this file's readers index into. */
const USABLE: Record<CollectorConfigFile, (body: unknown) => boolean> = {
  'config/pull.json': (body) => Array.isArray(body),
  'config/counters.json': (body) => isRecord(body) && isRecord(body.assets),
  'config/integrations.json': (body) => isRecord(body) && isRecord(body.assets),
  'config/ga4-custom-dimensions.json': (body) => isRecord(body) && isRecord(body.assets),
  'config/serp-panel.json': (body) => isRecord(body) && isRecord(body.assets),
  'config/constants.json': (body) => isRecord(body) && isRecord(body.flag_defaults),
};

/**
 * Resolve every collector document store-first, in one read. `files` narrows
 * it for a caller on a path of its own, so that caller still comes through
 * this reader rather than growing one.
 */
export async function readCollectorConfigs(
  env: Pick<IngestEnv, 'STORE'>,
  files: readonly CollectorConfigFile[] = COLLECTOR_CONFIG_FILES,
): Promise<CollectorConfigs> {
  const reads = await getConfigDocuments(env, files);
  const documents: Partial<Record<CollectorConfigFile, unknown>> = {};
  const sources: Partial<Record<CollectorConfigFile, ConfigSource>> = {};
  for (const read of reads) {
    const file = read.file as CollectorConfigFile;
    if (read.source === 'store' && USABLE[file](read.body)) {
      documents[file] = read.body;
      sources[file] = 'store';
      continue;
    }
    if (read.source === 'store') {
      console.warn(
        `${file} in the store is not the shape its readers need — using the compiled copy`,
      );
    }
    sources[file] = 'file';
  }
  return { documents, sources };
}

/**
 * The `configSource` field of one lane's completion line, narrowed to the
 * files that lane reads. Absent when nothing was resolved: a direct caller
 * that stated its own config must not claim it read the store or a file.
 */
export function configSourceLine(
  sources: ConfigSourceMap | undefined,
  files: readonly CollectorConfigFile[],
): { configSource?: Partial<Record<CollectorConfigFile, ConfigSource>> } {
  if (sources === undefined) return {};
  const named: Partial<Record<CollectorConfigFile, ConfigSource>> = {};
  for (const file of files) {
    const source = sources[file];
    if (source !== undefined) named[file] = source;
  }
  return Object.keys(named).length === 0 ? {} : { configSource: named };
}
