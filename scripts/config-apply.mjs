#!/usr/bin/env node
// Apply a config changeset in the operator's terminal.
//
// Settings documents are saved to the active database, then exported for the
// checkout's audit history; --seed-files edits offline seed files only.
// Asset-column changes
// go through the local ingest's asset-state door and must be submitted
// separately. `--remote` is refused (REMOTE_REFUSED). The database checks
// document versions again at Save, after the preview and prompt.

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  ChangesetError,
  DEFAULT_REPO_ROOT,
  LIFECYCLE_ANNOTATION_KIND,
  MISSING,
  applyFileOps,
  archiveChangeset,
  builtInDocumentReader,
  lifecycleMoveRef,
  resolve,
  resolveOps,
  writeDocumentFile,
  validateSchemaAndSafety,
} from './config-apply-core.mjs';
import { DEFAULT_DOOR, doorRequest, doorUrl, operatorToken } from './ingest-door.mjs';
import { CONFIG_APPLY_PATH, configStoreRequest, readConfigSnapshot } from './config-store-client.mjs';

// CONFIG_APPLY_REPO_ROOT points a run at a throwaway copy
// (apps/tower/test/config-write-lane.test.ts runs both entry points over
// identical temp repos).
const REPO_ROOT = process.env.CONFIG_APPLY_REPO_ROOT
  ? path.resolve(process.env.CONFIG_APPLY_REPO_ROOT)
  : DEFAULT_REPO_ROOT;

export { MISSING, resolve, validateSchemaAndSafety };

const c = process.stdout.isTTY
  ? {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    }
  : {
      dim: (s) => s,
      bold: (s) => s,
      red: (s) => s,
      green: (s) => s,
      yellow: (s) => s,
      cyan: (s) => s,
    };

function out(line = '') {
  process.stdout.write(line + '\n');
}
function fail(msg) {
  process.stderr.write(c.red('✘ ') + msg + '\n');
}

function show(v) {
  if (v === MISSING) return c.red('(absent)');
  return JSON.stringify(v);
}

export function parseArgs(argv) {
  const opts = {
    file: null,
    stdin: false,
    dryRun: false,
    yes: false,
    remote: false,
    seedFiles: false,
    door: DEFAULT_DOOR,
  };
  let wantsDoor = false;
  for (const a of argv) {
    if (wantsDoor) {
      opts.door = a;
      wantsDoor = false;
    } else if (a === '--stdin') opts.stdin = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--remote') opts.remote = true;
    else if (a === '--seed-files') opts.seedFiles = true;
    else if (a === '--door') wantsDoor = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) throw new ChangesetError(`unknown flag: ${a}`);
    else if (opts.file) throw new ChangesetError(`unexpected extra argument: ${a}`);
    else opts.file = a;
  }
  if (wantsDoor) throw new ChangesetError('--door needs a url');
  return opts;
}

function usage() {
  out(`${c.bold('pnpm config:apply')} — apply a config changeset the Tower exported.

  pnpm config:apply <file.json>
  pnpm config:apply --stdin <<'CHANGESET'
  { …changeset json… }
  CHANGESET

Flags:
  --dry-run   validate + show the diff, then stop (never prompts, never writes)
  --yes, -y   skip the y/N confirmation
  --seed-files  edit offline seed files only; does not change saved settings
  --door <url>  where the local ingest answers (default ${DEFAULT_DOOR})

Format + guarantees: config/changesets/README.md`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function loadChangeset(opts) {
  let raw;
  if (opts.stdin) {
    raw = await readStdin();
    if (!raw.trim()) throw new ChangesetError('--stdin given but nothing was piped in');
  } else if (opts.file) {
    try {
      raw = await fs.readFile(path.resolve(REPO_ROOT, opts.file), 'utf8');
    } catch (err) {
      throw new ChangesetError(`could not read ${opts.file}: ${err.message}`);
    }
  } else {
    throw new ChangesetError('need a <file.json> argument or --stdin');
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ChangesetError(`changeset is not valid JSON: ${err.message}`);
  }
}

// The store lane: the ingest's operator-authed asset-state routes on the
// loopback door, never a second runtime over the live store. There is no
// remote lane: a write around the ingest would change one store alone, and a
// deployed installation's Tower saves a site's columns through its ingest.

/** What `--remote` answers: nothing is read or written. */
export const REMOTE_REFUSED =
  '--remote changes nothing now: a deployed installation saves its settings and its sites in its own Tower. Nothing applied.';

/**
 * The two store operations this tool performs, through the ingest's door. A
 * run reads each asset's row at most once and nothing re-reads after the
 * apply, so the run-lifetime cache cannot go stale. `fetchImpl` and `token`
 * are injectable so the lane is testable without a running OS.
 */
export function storeLane({
  door = DEFAULT_DOOR,
  fetchImpl = fetch,
  token = null,
} = {}) {
  const rows = new Map(); // asset -> { known, columns }
  let bearer = token;

  async function authorization() {
    if (bearer === null) bearer = await operatorToken();
    return bearer;
  }

  /** Door failures are ChangesetErrors like every other refusal: the clean
   * `✘` line, not a stack trace. */
  async function throughTheDoor(work) {
    try {
      return await work();
    } catch (err) {
      throw err instanceof ChangesetError ? err : new ChangesetError(err.message);
    }
  }

  async function readRow(asset) {
    if (rows.has(asset)) return rows.get(asset);

    const body = await throughTheDoor(async () => {
      const response = await doorRequest(
        fetchImpl,
        doorUrl(door, 'api/asset-state', { asset }),
        { token: await authorization() },
      );
      return response.json();
    });
    const row = { known: body?.known === true, columns: body?.columns ?? null };

    rows.set(asset, row);
    return row;
  }

  /**
   * The `<from>` half of a stage move: the status the store held before this
   * run wrote anything, out of the run-lifetime cache the expect guard
   * filled, not a re-read that could catch the row mid-apply. Null when
   * nothing says where it started.
   */
  async function statusBefore(asset) {
    const row = await readRow(asset);
    if (!row.known) return null;
    const status = row.columns?.status;
    return typeof status === 'string' && status !== '' ? status : null;
  }

  /** Write the move as a timeline row, through the same door, with the kind
   * and ref shape the Tower records. */
  async function recordLifecycleMove(asset, move, at) {
    const ref = lifecycleMoveRef(move);
    const kind = LIFECYCLE_ANNOTATION_KIND;
    await throughTheDoor(async () =>
      doorRequest(fetchImpl, doorUrl(door, 'api/annotations', {}), {
        token: await authorization(),
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ asset, at, kind, ref }),
      }),
    );
    return ref;
  }

  return {
    /** The value the store holds now, or MISSING when there is no such asset. */
    async column(asset, column) {
      const row = await readRow(asset);
      if (!row.known) return MISSING;
      const value = row.columns?.[column];
      return value === undefined ? MISSING : value;
    },

    /**
     * Apply one `store-asset-set` op. A `status` op also records the move on
     * the timeline, which Restore reads to decide which stage to bring an
     * archived asset back to. Returns what was recorded, or null when there
     * was no move. A refusal of the record comes back in `error` rather than
     * thrown: the column has moved by then, and failing the run would archive
     * nothing and report a change that happened as one that did not.
     */
    async set(asset, column, value) {
      // Read before the write, out of the cache the expect guard filled.
      const expected = (await readRow(asset)).columns?.[column];
      if (expected === undefined) throw new ChangesetError('Asset column guard unavailable. Nothing applied.');
      const from = column === 'status' ? await statusBefore(asset) : null;
      const at = new Date().toISOString();

      const saved = await throughTheDoor(async () => {
        const response = await doorRequest(fetchImpl, doorUrl(door, 'api/asset-state', {}), {
          token: await authorization(),
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ asset, column, value, expect: expected }),
        });
        return response.json();
      });
      // Later operations in this run expect our own committed value.
      const row = await readRow(asset);
      row.columns = { ...row.columns, [column]: saved.value };

      // Nothing to record: another column, an unreadable starting stage, or a
      // move that lands where it already was.
      if (column !== 'status' || from === null || from === value) return null;
      try {
        return { ref: await recordLifecycleMove(asset, { from, to: value }, at), error: null };
      } catch (err) {
        return { ref: lifecycleMoveRef({ from, to: value }), error: err.message };
      }
    },
  };
}

// The human diff. File ops: file · pointer · current→proposed. Store ops:
// plain sentences.
const FILE_KINDS = new Set(['file-json-set', 'file-json-insert', 'file-json-delete']);

/** One line of the file diff. An insert and a delete each have only one
 * side, said in words. */
function fileDiffLine(r) {
  if (r.op.kind === 'file-json-insert') {
    return `    ${r.op.pointer}  ${c.green('+ add')} ${c.dim(show(r.op.value))}`;
  }
  if (r.op.kind === 'file-json-delete') {
    return `    ${r.op.pointer}  ${c.red('- remove')} ${c.dim(show(r.current))}`;
  }
  return `    ${r.op.pointer}  ${c.dim(show(r.current))} ${c.dim('→')} ${c.green(show(r.op.value))}`;
}

function printDiff(resolved) {
  const files = resolved.filter((r) => FILE_KINDS.has(r.op.kind));
  const stores = resolved.filter((r) => r.op.kind === 'store-asset-set');

  if (files.length) {
    out(c.bold('\nConfiguration documents'));
    // group by file for a readable diff
    const byFile = new Map();
    for (const r of files) {
      if (!byFile.has(r.op.file)) byFile.set(r.op.file, []);
      byFile.get(r.op.file).push(r);
    }
    for (const [file, rows] of byFile) {
      out('  ' + c.cyan(file));
      for (const r of rows) out(fileDiffLine(r));
    }
  }

  if (stores.length) {
    out(c.bold('\nStore (asset current-state)'));
    for (const r of stores) {
      const { asset, column, value } = r.op;
      let sentence;
      if (column === 'sense_only') {
        sentence = `${asset}: ${value === 1 ? 'set to sense-only (observe, no Act loop)' : 'take out of sense-only (Act loop may run)'}`;
      } else if (column === 'display_name') {
        sentence = `${asset}: rename to ${c.green(String(value))}`;
      } else {
        sentence = `${asset}: move lifecycle to ${c.green(String(value))}`;
      }
      out(`  ${sentence}  ${c.dim(`(${column}: ${show(r.current)} → ${show(value)})`)}`);
    }
  }
}

function printMismatches(mismatches) {
  fail(`${mismatches.length} op(s) no longer match current reality — applying nothing.`);
  out(c.dim('  (the config or store changed since this changeset was written — the expect guard stopped a blind overwrite)\n'));
  for (const m of mismatches) {
    const { op } = m;
    if (FILE_KINDS.has(op.kind)) {
      out(`  ${c.cyan(op.file)} ${op.pointer}`);
    } else {
      out(`  ${c.cyan(`${op.asset}.${op.column}`)}`);
    }
    out(`     expected ${c.yellow(show(m.expect))}, found ${c.red(show(m.current))}`);
  }
  out('\n' + c.dim('  Fix: reload the Tower so it reads the current values and edit there, or rewrite this changeset by hand.'));
}

// Read and apply through an explicit persistence mode. The preview uses the
// same acknowledged document the database version guard protects.
export async function prepareChangeset(cs, store, opts = {}) {
  validateSchemaAndSafety(cs);
  const fileOps = cs.ops.filter((op) => FILE_KINDS.has(op.kind));
  const assetOps = cs.ops.filter((op) => op.kind === 'store-asset-set');
  if (opts.remote) throw new ChangesetError(REMOTE_REFUSED);
  if (opts.seedFiles && assetOps.length > 0) {
    throw new ChangesetError('--seed-files accepts only offline document edits.');
  }
  if (fileOps.length > 0 && assetOps.length > 0) {
    throw new ChangesetError('Submit document settings and asset-column changes separately; they cannot save atomically. Nothing applied.');
  }
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  if (opts.seedFiles || fileOps.length === 0) {
    return { ...await resolve(cs, store, { repoRoot }), mode: opts.seedFiles ? 'seed-files' : 'assets', versions: {} };
  }
  const snapshot = await readConfigSnapshot(opts);
  const files = [...new Set(fileOps.map((op) => op.file))];
  const missing = files.filter((file) => !snapshot.has(file));
  if (missing.length > 0) {
    throw new ChangesetError(`The database has not stored ${missing.join(', ')}. Seed the configuration before applying changes, or use --seed-files to edit offline seed files explicitly.`);
  }
  const { resolved, mismatches, documents } = await resolveOps(cs, store, {
    readDocument: async (file) => snapshot.get(file)?.body ?? null,
    // What the Worker compares a key its document lacks with, so the preview
    // agrees with the door.
    readBuiltIn: builtInDocumentReader({ repoRoot }),
  });
  return { resolved, mismatches, fileCache: documents, mode: 'database',
    versions: Object.fromEntries(files.map((file) => [file, snapshot.get(file).version])) };
}

export async function applyChangeset(cs, prepared, store, opts = {}) {
  const { resolved, fileCache, mode, versions } = prepared;
  if (prepared.mismatches.length > 0) throw new ChangesetError('The preview has conflicts. Nothing applied.');
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const changedFiles = [];
  if (mode === 'database') {
    const reply = await configStoreRequest(CONFIG_APPLY_PATH, {
      ...opts, method: 'POST', body: { ops: cs.ops, expectVersions: versions,
        actor: 'config:apply', slug: cs.slug },
    }).catch(() => {
      throw new ChangesetError('Database save outcome is unknown. Check current settings before retrying; no files were changed.');
    });
    if (reply.status < 200 || reply.status >= 300 || reply.body?.ok !== true) {
      const refusal = reply.status >= 400 && reply.body?.ok !== true && typeof reply.body?.error === 'string';
      throw new ChangesetError(refusal
        ? `Database refused the changes (${reply.body.error}). Reload current settings before retrying.`
        : 'Database save outcome is unknown. Check current settings before retrying; no files were changed.');
    }
    const documents = reply.body.documents;
    const expected = Object.keys(versions);
    if (reply.body.applied !== cs.ops.length || !Array.isArray(documents)
      || documents.length !== expected.length
      || new Set(documents.map((doc) => doc?.file)).size !== expected.length
      || documents.some((doc) => !expected.includes(doc?.file)
        || doc.version !== versions[doc.file] + 1 || !doc.body || typeof doc.body !== 'object')) {
      throw new ChangesetError('Database acknowledged a save but returned incomplete export evidence. Check current settings and run config:export; do not reapply blindly.');
    }
    out(`  ${c.green('saved')} ${cs.ops.length} operation(s) to the configuration database`);
    try {
      for (const doc of documents) {
        const written = await writeDocumentFile(doc.file, doc.body, { repoRoot });
        changedFiles.push(written);
        out(`  ${c.green('exported')} ${written}`);
      }
    } catch {
      out(c.yellow('  Settings are saved, but the checkout export failed. Run pnpm config:export; do not repeat the save.'));
      return { changedFiles, exported: false };
    }
  } else {
    changedFiles.push(...await applyFileOps(resolved, fileCache, { repoRoot, at: cs.createdAt }));
    for (const rel of changedFiles) out(`  ${c.green('updated seed file')} ${rel}`);
  }

  for (const r of resolved) {
    if (r.op.kind !== 'store-asset-set') continue;
    const { asset, column, value } = r.op;
    const record = await store.set(asset, column, value);
    out(`  ${c.green('updated')} ${asset}.${column} → ${show(value)}`);
    // The record and the value can succeed separately.
    if (record?.error) {
      out(`  ${c.yellow('not recorded')} ${asset} ${record.ref} — ${record.error}`);
    } else if (record) {
      out(`  ${c.green('recorded')} ${asset} ${c.dim(record.ref)} on the timeline`);
    }
  }

  return { changedFiles, exported: true };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  const cs = await loadChangeset(opts);
  validateSchemaAndSafety(cs);

  out(c.bold(`Changeset ${c.cyan(cs.slug)}`) + c.dim(`  · ${cs.ops.length} op(s) · staged ${cs.createdAt}`));

  // One lane for the whole run, so the reads the expect guard makes and the
  // writes the apply makes go the same way and share one bearer.
  const store = storeLane({ door: opts.door });
  const prepared = await prepareChangeset(cs, store, opts);
  const { resolved, mismatches } = prepared;
  out(c.dim(prepared.mode === 'seed-files'
    ? 'Offline seed files only — the running OS will not change.'
    : prepared.mode === 'database' ? 'Target: active configuration database; checkout files are exports.' : 'Target: asset state.'));

  if (mismatches.length) {
    printMismatches(mismatches);
    process.exitCode = 1;
    return;
  }

  printDiff(resolved);

  if (opts.dryRun) {
    out('\n' + c.dim('dry run — validated and previewed, nothing written.'));
    return;
  }

  if (!opts.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`\nApply these ${resolved.length} change(s)? ${c.dim('[y/N]')} `)).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      out(c.dim('aborted — nothing written.'));
      return;
    }
  }

  out('');
  const { changedFiles } = await applyChangeset(cs, prepared, store, opts);
  let archivePath;
  try {
    archivePath = await archiveChangeset(cs, { repoRoot: REPO_ROOT });
  } catch {
    out(c.yellow('  Changes were applied, but the checkout archive failed. Keep the input changeset; do not repeat the apply.'));
    return;
  }
  out(`  ${c.green('archived')} ${archivePath}`);

  // git hint — the changed config files (if any) + the archive.
  const toAdd = [...changedFiles, archivePath];
  out('\n' + c.bold('Commit it:'));
  out(c.dim('  ') + `git add ${toAdd.join(' ')}`);
  out(c.dim('  ') + `git commit -m ${JSON.stringify(`config: ${cs.slug}`)}`);
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((err) => {
    if (err instanceof ChangesetError) {
      fail(err.message);
      process.exitCode = 1;
    } else {
      fail(`unexpected: ${err?.stack || err?.message || err}`);
      process.exitCode = 1;
    }
  });
}
