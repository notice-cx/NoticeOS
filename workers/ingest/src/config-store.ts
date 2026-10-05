// The config store — where a setting is read from, and the one door it is
// written through (epic `ro-syok`). On Postgres (the port pattern,
// docs/briefs/2026-09-29-postgres-port-pattern.md; bead ro-ujb9.76.4.1): the
// tables config_documents and config_changes, through this call's store,
// `env.STORE`.
//
// WHAT MOVED AND WHAT DID NOT. Until now every config file was compiled into
// both Workers: `apps/tower/vite.config.ts` injects twelve of them with `define`
// and this Worker imports the five its collectors need. That is a fine way to
// SHIP software and a hopeless way to OPERATE it — a deployed Tower could render
// a setting and never save one, because config is version-controlled files
// (docs/06) and a Worker has no filesystem. So the store now holds each config
// file as a whole JSON document keyed by its file's name (`config/tower.json`
// is `tower`, scripts/config-documents.mts `configDocumentKey`), and this
// module is the only thing in either Worker that reads or writes one. Its
// callers still name a document by its path.
//
// THE FILES ARE STILL THERE, as seed and as export. `pnpm config:seed` loads
// them in; `pnpm config:export` writes them back; the repo's history is the
// audit trail it always was, now with `config_changes` beside it. An install
// whose store holds no document yet behaves EXACTLY as one before the store
// did, because every read falls back to the copy compiled into this Worker.
//
// WHOLE DOCUMENTS, NOT TYPED TABLES. Every register, knob, pointer and validator
// in `scripts/config-documents.mjs` already operates on a parsed JSON document,
// and the changeset vocabulary the Tower, the CLI and the dev write lane all
// speak is RFC-6901 pointers into one. So the ops apply here unchanged; only
// where the document comes from and goes to is different. A second, typed
// representation would be a second answer to "what may the Tower edit", which is
// the exact failure `config-registers.mjs` exists to prevent.
//
// WHY THE PIPELINE IS IMPORTED FROM scripts/. `config-documents.mjs` is plain
// ESM with no `node:` import precisely so it can bundle into this Worker;
// `config-apply-core.mjs` is the same pipeline plus a filesystem and is what the
// terminal uses. One module decides; two places persist the answer.
//
// A STORE THAT FAILS IS AN ERROR, never a fallback. The Postgres store is
// built whole by its baseline (db/postgres/migrations), so D1's "the migration
// is not applied yet" cannot happen: a read or a write that cannot reach the
// store throws. The compiled copy answers only for a document the store does
// not hold, which is the unseeded install above, and a WRITE never degrades —
// a Save that silently did nothing is the worst outcome available.

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

// The ordinary Worker retains its existing compiled fallback, including the
// exclusion of the coordination document. Provisioning uses the complete
// released defaults from that same source. Neither path reads installation files.
import { collectorDefaultDocument } from '../../../scripts/config-defaults.mjs';

/** Every file the store may hold a document for. Derived from the register
 * declarations, so a new register is storable without a code change here. */
export { CONFIG_DOCUMENT_FILES };

import type { ConfigSource, ConfigDocumentRead, ApplyConfigOpsInput, ConfigWriteMismatch, ApplyConfigOpsResult } from '@noticeos/contract/configuration';
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
// ONE SECOND, and invalidated on every write from this isolate.
//
// It exists because a config read is per-REQUEST now rather than per-BUILD: one
// Wall poll resolves a dozen documents, several times a minute, for rows an
// operator changes a few times a week. Without a cache that is a dozen store
// round trips on the hot path of the display that has to stay smooth.
//
// One second is the number because it is shorter than anything that reads a
// value back after writing it: `useConfigSave` waits 1500ms before invalidating
// its queries, so a Save is never read back stale even in the isolate that did
// not perform it. Longer than that and the operator would see their own change
// arrive late, which is the one staleness a settings page may not have.

const CACHE_MS = 1000;
type DocumentCache = Map<string, { at: number; row: StoredRow | null }>;
// Where the store is and which workspace a call acts for are the cache key:
// one isolate serves many calls, each with its own store, and a hosted
// installation's workspaces, or two stores, must never share an answer.
let caches = new Map<string, DocumentCache>();

/** Invalidate what was cached from `store` after a write to it; omit it to reset all tests. */
export function forgetConfigCache(store?: WorkspaceStore): void {
  if (!store) {
    caches = new Map();
    return;
  }
  for (const key of caches.keys()) if (key.startsWith(`${store.where}\n`)) caches.delete(key);
}

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

/** A stored row's document, or null when its JSON does not parse.
 *
 * A body that will not parse is a corrupted row rather than a setting, and the
 * honest answer is the compiled file plus a log line — a Worker that threw here
 * would take every page down over one bad character. */
function parseBody(row: StoredRow): JsonValue | null {
  try {
    return JSON.parse(row.body_json) as JsonValue;
  } catch {
    console.warn(`config_documents ${row.file} v${row.version} does not parse — using the file`);
    return null;
  }
}

/**
 * The compiled copy of one file — A COPY, never the module object itself
 * (bead `ro-pg1l`).
 *
 * `BUNDLED` holds the objects `import constantsJson from …` compiled into this
 * Worker, and they live for the life of the isolate. `applyConfigOps` hands
 * whatever this answered to `applyDocumentOps`, which mutates the document it
 * was given by design — the caller owns persisting it. So handing back the
 * module object meant a FIRST save on an unseeded install edited the Worker's
 * own compiled config in memory, before a single D1 statement had run.
 *
 * Normally the write then lands and every later read comes from the store, so
 * the mutation is invisible. It stops being invisible when the write does NOT
 * land — the guarded UPDATE loses its race, the INSERT hits `ON CONFLICT DO
 * NOTHING`, or D1 errors afterwards. The isolate would then answer reads with a
 * compiled document carrying an edit nobody persisted, and "an unseeded install
 * behaves exactly as it did before" would stop being true for the rest of that
 * isolate's life.
 *
 * The store branch has always handed out a fresh object (`JSON.parse` per
 * read); this makes the file branch say the same thing.
 */
function bundled(file: string): JsonValue | null {
  return collectorDefaultDocument(file);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Several documents in one round trip — what a page load actually needs. */
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
  // `getConfigDocuments` maps over its input, so a one-element input always
  // answers a one-element output; the fallback keeps the type honest.
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

/** Which files the store actually holds — what `pnpm config:seed` and the
 * runner's startup line report as seeded — in file order. */
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

/** MISSING is a symbol and does not survive an RPC boundary, so an absent value
 * says so in a field of its own — the same shape the dev write lane has always
 * put on the wire. */
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
 * Apply one changeset to the stored documents, and record what it did.
 *
 * THE SEQUENCE, and every step of it refuses before anything is written:
 * validate the changeset against the declarations → read the documents the ops
 * name → check each file's version against the one the caller read → resolve
 * every op's `expect` against the document → apply → write all documents behind
 * one version guard, followed by their audit rows in the same transaction.
 *
 * A DOCUMENT THE STORE DOES NOT HOLD YET IS SEEDED BY THIS WRITE, from the copy
 * compiled into this Worker, and its audit row records `version_before = 0`. The
 * alternative — refusing until somebody runs `pnpm config:seed` — would mean a
 * freshly deployed Tower could still not save a setting, which is the whole
 * thing this epic exists to fix. The `expect` guard is unaffected: the browser
 * rendered the field from the compiled document, and that is exactly what the
 * op is checked against.
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
  // An asset's stage, automation mode or name is a store COLUMN and is written
  // through its own route. Refused by name rather than ignored: it is a real
  // part of the changeset vocabulary, just not this door's. The refusal is the
  // route it belongs to, in the dev lane's own words (bead `ro-ujb9.96.6.29`,
  // apps/tower/vite/config-write-lane.ts).
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

  // Neither the store nor this deployment holds the file: the state, the
  // files and the command that seeds them from a checkout (bead
  // `ro-ujb9.96.6.29`).
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
      // compiled copy, as a whole document the store lacks is (bead `ro-dk4u`).
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

  // `at` is this changeset's own instant, which is also what `config_changes`
  // records — so a date the write stamps into a document (bead `ro-auav`) names
  // the same day the audit row does, on this path exactly as on the file one.
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
  // ONE TRANSACTION for the whole changeset. Each document is written only if
  // the store still holds the version this write started from (a missing
  // document is version 0, so a concurrent first seed counts as a competing
  // save), and every row it did not write refuses the whole changeset: the
  // transaction rolls back, and no document moves and no audit row lands.
  // Only then are the audit rows written, in the same transaction.
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
  /** Re-seed a document that is already there. Every forced file needs a reason
   * — overwriting somebody's saved settings from a file is a deliberate act. */
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
 * Load documents the store does not have yet. NEVER an overwrite: a file already
 * in the store is reported as skipped, with the version it is at.
 *
 * That rule is the whole safety of running `pnpm config:seed` twice, and of
 * running it after months of Saves — the checkout may be behind the store, and a
 * seed that silently won would undo every setting the operator changed in the
 * product. `--force <file> --reason <why>` is the deliberate way past it, and it
 * records a `config_changes` row like any other change.
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
// ONE READER, ONE ROUND TRIP, ONE FALLBACK RULE (bead `ro-syok.7`).
//
// Every config document a collector needs is resolved HERE, together, once per
// cron fire — `dispatch.ts` calls this and hands each lane what it asked for.
// Read here rather than inside each lane for two reasons that both matter:
//
//   1. A COLLECTOR KEEPS TAKING ITS CONFIG AS A PARAMETER. That is what lets a
//      suite state its own mapping without editing the operator's file, and it
//      is what stops a second module becoming a second reader of a config file.
//   2. ONE ROUND TRIP. Six documents, one `SELECT … WHERE file IN (…)`, one
//      cache policy — the one above. A per-lane read would be six.
//
// `undefined` IS THE FALLBACK RULE, WRITTEN ONCE. A document the store does not
// hold — or holds in a shape its readers cannot use — answers `undefined`, which
// is exactly what each lane's existing override option means: keep the copy
// compiled into this Worker, byte for byte. So a run on an unseeded install is
// the run it was yesterday, and no lane carries a second copy of that rule.
//
// THE SHAPE CHECK IS DELIBERATELY SHALLOW. It asks only whether the container a
// reader indexes into is there; the readers themselves are already total about
// what is inside it. A collector that stopped collecting over one malformed key
// would be a worse outcome than a stale document, and the run says which of the
// two it read either way.

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
 * Per file, which of the two answered on this run.
 *
 * THE WORD ONLY. A completion line carries `{"config/integrations.json":"store"}`
 * and never a document — config holds property ids, tracked queries and spend
 * caps, and a log is the one place none of them belong.
 */
export type ConfigSourceMap = Readonly<Partial<Record<CollectorConfigFile, ConfigSource>>>;

export interface CollectorConfigs {
  /** Per file: the stored document, or `undefined` to keep the compiled copy. */
  documents: Readonly<Partial<Record<CollectorConfigFile, unknown>>>;
  sources: ConfigSourceMap;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
 * Resolve every collector document store-first, in one read.
 *
 * `files` narrows it for a caller on a path of its own — the panel-landings read
 * the runner asks for, which is not a cron fire — so that caller still comes
 * through this reader rather than growing one.
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
 * The `configSource` field of one lane's completion line, narrowed to the files
 * that lane actually reads.
 *
 * ABSENT WHEN NOTHING WAS RESOLVED. A direct caller — every suite in
 * `workers/ingest/test` — states its own config, and a run that read neither the
 * store nor a file must not claim it read one. So the field appears on a real
 * cron fire and nowhere else, which is also what keeps every existing log
 * assertion true.
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
