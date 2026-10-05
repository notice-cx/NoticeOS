// config-apply-core.mts — the config CHANGESET pipeline over FILES.
//
// THREE ENTRY POINTS APPLY CONFIG NOW, and they must apply it identically:
//
//   1. `pnpm config:apply` (scripts/config-apply.mjs) — the operator's terminal
//      tool, which also speaks to the store and prints a human diff.
//   2. The Tower's local write lane (apps/tower/vite/config-write-lane.ts) — a
//      Vite middleware in the `os:up` dev server, which is the deployment the
//      operator actually uses, so a Save in the browser writes the same
//      document, archives the same changeset and lands the same commit (D18,
//      ro-pbzu.5).
//   3. The ingest Worker (`applyConfigOps`, epic `ro-syok`) — the deployed path,
//      which applies the very same ops to a `config_documents` row because a
//      Worker has no filesystem.
//
// THE THIRD IS WHY THIS FILE SHRANK. Everything that DECIDES anything — the
// safety allowlists, the schema validation, the RFC-6901 pointer ops, the expect
// guard and the application itself — moved to `./config-documents.mjs`, which
// imports nothing from `node:` and therefore bundles into a Worker. This module
// is now the FILESYSTEM half: a repo root, a read-modify-write, and the numbered
// changeset archive. It re-exports every name it moved, so nothing that already
// imported it has to learn a second module.
//
// WHAT MAY BE EDITED IS DECLARED, NOT HARD-CODED (2026-09-05, bead ro-x5gu.1):
// see `./config-registers.mjs`, and the permission model spelled out at the top
// of `./config-documents.mjs`.
//
// What stays with the CLI: arg parsing, the store lane (the editable `assets`
// columns, reached through the ingest's loopback door — the lane writes those
// over the Worker's Service Binding instead), the printed diff, the y/N prompt.
//
// Authored TypeScript (bead ro-ujb9.61), no dependencies. `pnpm config:generate`
// writes the plain Node `config-apply-core.mjs` the CLI runs without a build step
// and the `config-apply-core.d.mts` the Tower's write lane compiles against, so
// the lane's calls are checked against these exact signatures.
//
// `repoRoot` is a PARAMETER on every filesystem function, defaulting to this
// repo. Both file entry points pass their own — and it is what lets a test run
// the whole pipeline over a throwaway repo without a `--dry-run` flag standing
// in for the real thing.
//
// WHICH FILE A DOCUMENT IS (bead ro-ujb9.125). A document is named by its store
// key, `config/<name>.json`; its file is found through `./installation.mjs`.
// A read takes this installation's copy when there is one and the product's
// generic default in `config/` when there is not; every write, and the archive,
// goes to the installation folder. So a fresh clone seeds the defaults, and a
// Save never writes one installation's settings into the product.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChangesetError,
  applyDocumentOps,
  resolveOps,
  serializeDocument,
} from './config-documents.mjs';
import type { Changeset, DocumentReader, Mismatch, Resolved, StoreLane } from './config-documents.mjs';
import {
  CHANGESETS_DIR as INSTALLATION_CHANGESETS,
  checkoutRelative,
  installationPath,
  productDefaultPath,
  readablePath,
} from './installation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The whole decision surface, re-exported so `pnpm config:apply`, the write lane
// and every test keep reaching it where they always did.
export {
  ADDABLE_CONTAINERS,
  ADDABLE_DOCUMENTS,
  ALLOWED_FILES,
  ASSET_ID_RE,
  ASSET_STATUS,
  CONFIG_DOCUMENT_FILES,
  CONFIG_KNOBS,
  CONFIG_REGISTERS,
  ChangesetError,
  DISPLAY_NAME_MAX,
  DOCUMENT_STAMPS,
  MISSING,
  STORE_COLUMNS,
  applyDocumentOps,
  deepEqual,
  expectsAbsent,
  parsePointer,
  pointerDelete,
  pointerGet,
  pointerInsert,
  pointerSet,
  resolveOps,
  serializeDocument,
  validateSchemaAndSafety,
} from './config-documents.mjs';
export type {
  Changeset,
  ChangesetOp,
  DocumentReader,
  FileJsonDeleteOp,
  FileJsonInsertOp,
  FileJsonSetOp,
  JsonValue,
  Mismatch,
  Resolved,
  StoreAssetSetOp,
  StoreLane,
} from './config-documents.mjs';

export interface RepoOption {
  repoRoot?: string;
}

/** This repo, as seen from scripts/. Every function takes an override. */
export const DEFAULT_REPO_ROOT: string = path.resolve(__dirname, '..');

/** Where an applied changeset is archived: `changesets/` in this
 * installation's folder, absolute. */
export function changesetsDir({ repoRoot = DEFAULT_REPO_ROOT }: RepoOption = {}): string {
  return installationPath(INSTALLATION_CHANGESETS, { root: repoRoot });
}

/** Write one document to this installation's copy, creating the folder. */
async function writeInstalled(rel: string, doc: unknown, repoRoot: string): Promise<string> {
  const file = installationPath(rel, { root: repoRoot });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, serializeDocument(doc), 'utf8');
  return checkoutRelative(file, { root: repoRoot });
}

/**
 * Read one config document off disk, parsed — the `readDocument` the filesystem
 * entry points hand to `resolveOps`.
 *
 * It throws a plain Error; `resolveOps` is what turns that into the
 * `could not read/parse <file>: <why>` refusal both lanes have always printed.
 */
export function fileDocumentReader({ repoRoot = DEFAULT_REPO_ROOT }: RepoOption = {}): DocumentReader {
  return async (rel: string) => JSON.parse(await fs.readFile(readablePath(rel, { root: repoRoot }), 'utf8'));
}

/**
 * The product's own default for one document — the copy both Workers compile
 * in and every reader falls back to per key — as the `readBuiltIn` the
 * filesystem entry points hand to `resolveOps` (bead `ro-dk4u`).
 */
export function builtInDocumentReader({ repoRoot = DEFAULT_REPO_ROOT }: RepoOption = {}): DocumentReader {
  return async (rel: string) => JSON.parse(await fs.readFile(productDefaultPath(rel, { root: repoRoot }), 'utf8'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve every op against the files on disk; collect ALL expect mismatches.
// Nothing is written here — this is the read-only checkpoint. A changeset with
// one mismatch applies NONE of its ops, in either file entry point.
//
// `fileCache` is the name this returned Map has always had, and it is the same
// object `resolveOps` calls `documents`: the parsed files, read once and mutated
// by `applyFileOps` below.
// ─────────────────────────────────────────────────────────────────────────────
export async function resolve(
  cs: Changeset,
  store: StoreLane | null,
  { repoRoot = DEFAULT_REPO_ROOT }: RepoOption = {},
): Promise<{ resolved: Resolved[]; mismatches: Mismatch[]; fileCache: Map<string, unknown> }> {
  const { resolved, mismatches, documents } = await resolveOps(cs, store, {
    readDocument: fileDocumentReader({ repoRoot }),
    readBuiltIn: builtInDocumentReader({ repoRoot }),
  });
  return { resolved, mismatches, fileCache: documents };
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply the FILE half. Stable 2-space JSON + trailing newline, each touched
// file written exactly once, to this installation's copy. The store half
// belongs to the caller: the CLI has the ingest door, the lane has the
// Worker's Service Binding. Returns the written paths, as a commit names them.
//
// `at` is the changeset's own `createdAt`, passed through to the stamps a write
// refreshes (bead `ro-auav`) so the file's stated date and the archived
// changeset beside it name the same day. Absent ⇒ now.
// ─────────────────────────────────────────────────────────────────────────────
export async function applyFileOps(
  resolved: Resolved[],
  fileCache: Map<string, unknown>,
  { repoRoot = DEFAULT_REPO_ROOT, at }: RepoOption & { at?: string } = {},
): Promise<string[]> {
  const touched = applyDocumentOps(resolved, fileCache, { at });
  const written: string[] = [];
  for (const rel of touched) written.push(await writeInstalled(rel, fileCache.get(rel), repoRoot));
  return written;
}

/**
 * Write one whole document to this installation's copy — what
 * `pnpm config:export` does for every document the store holds, in the same
 * bytes a Save would have left. Returns the path written, as a commit names it.
 */
export async function writeDocumentFile(rel: string, doc: unknown, { repoRoot = DEFAULT_REPO_ROOT }: RepoOption = {}): Promise<string> {
  return writeInstalled(rel, doc, repoRoot);
}

async function readParsed(file: string, rel: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ChangesetError(`could not read/parse ${rel}: ${(err as Error).message}`);
  }
}

/** Read one config document off disk, parsed — the seed side of the same coin:
 * this installation's copy, else the product's default. Neither there answers
 * `null` rather than throwing, because "this install does not carry that
 * register" is an ordinary state for a seed to be in. */
export async function readDocumentFile(rel: string, { repoRoot = DEFAULT_REPO_ROOT }: RepoOption = {}): Promise<unknown> {
  return readParsed(readablePath(rel, { root: repoRoot }), rel);
}

/** Read this installation's own copy of a document, or `null` when it has
 * none — what `pnpm config:export` compares the store against. The product
 * default never stands in: an export is the installation's own. */
export async function readInstalledDocument(rel: string, { repoRoot = DEFAULT_REPO_ROOT }: RepoOption = {}): Promise<unknown> {
  return readParsed(installationPath(rel, { root: repoRoot }), rel);
}

// ─────────────────────────────────────────────────────────────────────────────
// Archive to <installation>/changesets/NNNN_<slug>.json — next number,
// migration-style. The archive is the audit artifact whichever entry point
// applied the change, and it is one installation's history, never the product's.
// ─────────────────────────────────────────────────────────────────────────────
export async function nextArchiveNumber({ repoRoot = DEFAULT_REPO_ROOT }: RepoOption = {}): Promise<number> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(changesetsDir({ repoRoot }));
  } catch {
    return 1;
  }
  let max = 0;
  for (const name of entries) {
    const m = /^(\d{4})_.*\.json$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Write the applied changeset to its numbered archive; returns its path as a
 * commit names it, which is also what the caller commits. */
export async function archiveChangeset(cs: Changeset, { repoRoot = DEFAULT_REPO_ROOT }: RepoOption = {}): Promise<string> {
  const dir = changesetsDir({ repoRoot });
  await fs.mkdir(dir, { recursive: true });
  const n = await nextArchiveNumber({ repoRoot });
  const name = `${String(n).padStart(4, '0')}_${cs.slug}.json`;
  await fs.writeFile(path.join(dir, name), JSON.stringify(cs, null, 2) + '\n', 'utf8');
  return checkoutRelative(path.join(dir, name), { root: repoRoot });
}

// ─────────────────────────────────────────────────────────────────────────────
// A lifecycle stage move is an EVENT, and the `ref` that says so (bead ro-mz39).
//
// `assets.status` records where an asset IS; the record of where it HAS BEEN
// lives on the annotation timeline, written by every surface that moves the
// stage (bead `ro-3085`, commit f2ce513). Restore reads the most recent recorded
// move into `retired` to decide which stage to bring an archived asset back to,
// so a writer that moves the column and records nothing sends the asset back to
// a labelled default instead.
//
// THE STRING IS DEFINED TWICE ON PURPOSE. `apps/tower/shared/asset-detail.ts`
// owns it for the Tower (`LIFECYCLE_ANNOTATION_KIND`, `LIFECYCLE_REF_PREFIX`,
// `lifecycleMoveRef`) and this is the same three lines for the terminal, because
// `pnpm test:scripts` is bare `node --test` with no TS loader and no build
// artifact to import — the reason `scripts/handoff-kinds.test.mjs` gives at
// length for reading its sources by regex rather than importing them.
// `scripts/lifecycle-ref.test.mjs` is what keeps the two answers identical: it
// reads the TypeScript and compares, move by move, against what this file
// returns. Changing one without the other fails that gate.
// ─────────────────────────────────────────────────────────────────────────────

/** `annotations.kind` for a stage move. Not a new kind: `annotations.kind` is a
 * CHECK constraint in db/0001, and `config` is the closest honest member — a
 * stage is a stored setting on the asset. */
export const LIFECYCLE_ANNOTATION_KIND: string = 'config';

/** What a lifecycle-move `ref` starts with, so an operator-written ref can never
 * be mistaken for one. */
export const LIFECYCLE_REF_PREFIX: string = 'lifecycle:';

/**
 * The `ref` one stage move is stored under — `lifecycle:baselining>retired`.
 *
 * Machine-readable ASCII, and part of the row's `(asset, at, kind, ref)`
 * identity, so a retried write collapses into one row and two different moves
 * recorded in the same second stay two.
 */
export function lifecycleMoveRef({ from, to }: { from: string; to: string }): string {
  return `${LIFECYCLE_REF_PREFIX}${from}>${to}`;
}
