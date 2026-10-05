#!/usr/bin/env node
// config-seed.mjs — load the config documents into the store (epic `ro-syok`,
// db/0029).
//
// WHICH FILES (bead ro-ujb9.125). Each document is read from this installation's
// folder (`installation/`, or `NOTICEOS_INSTALLATION_DIR`) when it holds a
// copy, else from the product's generic default in `config/`. So a fresh clone
// seeds an empty installation: no assets, no task projects, UTC.
//
// WHAT THE FILES ARE NOW. docs/06 chose file config for auditability and
// reproducibility, and both survive: the files are the SEED and the EXPORT, and
// the store is what a running OS reads and writes. This command is the seed half
// — it loads each config file into `noticeos.config_documents` where no document exists
// yet, and it is the moment the store starts winning on an install.
//
// IT NEVER OVERWRITES. A file already in the store is reported as skipped, with
// the version it is at. That rule is the whole safety of running this twice, and
// of running it after months of Saves: the checkout may be BEHIND the store, and
// a seed that silently won would undo every setting the operator changed in the
// product. `pnpm config:export` is the direction that puts the store back into
// the files.
//
//   pnpm config:seed
//   pnpm config:seed --file config/tower.json         # just one
//   pnpm config:seed --force config/tower.json --reason "restored from backup"
//   flags: --door <url>  --dry-run
//
// A forced re-seed needs a reason. Overwriting somebody's saved settings from a
// file is a deliberate act, and the reason lands in `noticeos.config_changes` beside the
// versions either side of it.
//
// Plain Node ESM — no TypeScript, no build step, no dependencies. House style of
// creds-rotate-key.mjs: a tiny arg parser, plain logging, one job.

import { CONFIG_DOCUMENT_FILES } from './config-documents.mjs';
import { readDocumentFile } from './config-apply-core.mjs';
import {
  CONFIG_DOCUMENTS_PATH,
  CONFIG_SEED_PATH,
  DEFAULT_DOOR,
  configStoreRequest,
} from './config-store-client.mjs';

/** Who a seeded document says wrote it. */
export const SEED_ACTOR = 'config:seed';

const c = process.stdout.isTTY
  ? {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    }
  : { dim: (s) => s, red: (s) => s, green: (s) => s, yellow: (s) => s };

function out(line = '') {
  process.stdout.write(line + '\n');
}

export function parseArgs(argv) {
  const opts = { files: [], force: [], reason: null, door: DEFAULT_DOOR, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') opts.files.push(argv[++i]);
    else if (arg === '--force') {
      const file = argv[++i];
      opts.force.push(file);
      opts.files.push(file);
    } else if (arg === '--reason') opts.reason = argv[++i];
    else if (arg === '--door') opts.door = argv[++i];
    else if (arg === '--dry-run') opts.dryRun = true;
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (opts.force.length > 0 && (opts.reason ?? '').trim() === '') {
    throw new Error('--force needs --reason: re-seeding overwrites what the store holds.');
  }
  const unknown = opts.files.filter((file) => !CONFIG_DOCUMENT_FILES.includes(file));
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.join(', ')} is not a config document — the OS knows ${CONFIG_DOCUMENT_FILES.join(', ')}`,
    );
  }
  return opts;
}

/**
 * Read the documents this run would send, off the checkout.
 *
 * A file that is not there is left out rather than sent as null: an install that
 * does not carry a register is an ordinary state, and the store's own list is
 * what says which documents it ended up with.
 */
export async function readSeedDocuments(files, { repoRoot } = {}) {
  const documents = {};
  const absent = [];
  for (const file of files) {
    const doc = await readDocumentFile(file, repoRoot === undefined ? {} : { repoRoot });
    if (doc === null) absent.push(file);
    else documents[file] = doc;
  }
  return { documents, absent };
}

/** The lines this command prints, as data — so the suite asserts the report
 * rather than a transcript. */
export function seedReport(body, { absent = [] } = {}) {
  if (body?.error === 'store_unavailable') {
    return [c.red('✘ nothing was seeded'), `  ${body.detail}`];
  }
  const lines = [];
  for (const row of body?.seeded ?? []) {
    lines.push(`${c.green('✓')} ${row.file} ${c.dim(`→ version ${row.version}`)}`);
  }
  for (const row of body?.skipped ?? []) {
    lines.push(
      `${c.dim('·')} ${row.file} ${c.dim(`already seeded at version ${row.version} — left alone`)}`,
    );
  }
  for (const row of body?.refused ?? []) {
    lines.push(`${c.red('✘')} ${row.file} — ${row.detail}`);
  }
  for (const file of absent) {
    lines.push(`${c.yellow('!')} ${file} ${c.dim('is not in this checkout — nothing to seed')}`);
  }
  if (lines.length === 0) lines.push(c.dim('· nothing to seed'));
  return lines;
}

export async function runSeed({
  files = CONFIG_DOCUMENT_FILES,
  force = [],
  reason = null,
  door = DEFAULT_DOOR,
  token,
  fetchImpl = fetch,
  repoRoot,
} = {}) {
  const { documents, absent } = await readSeedDocuments(files, { repoRoot });
  if (Object.keys(documents).length === 0) {
    return { status: 200, body: { ok: true, seeded: [], skipped: [], refused: [] }, absent };
  }
  const { status, body } = await configStoreRequest(CONFIG_SEED_PATH, {
    door,
    token,
    fetchImpl,
    method: 'POST',
    body: { documents, actor: SEED_ACTOR, force, reason },
  });
  return { status, body, absent };
}

/** What the store already holds — the `--dry-run` answer, and the same read the
 * runner's startup line makes. */
export async function readSeedState({ door = DEFAULT_DOOR, token, fetchImpl = fetch } = {}) {
  const { body } = await configStoreRequest(CONFIG_DOCUMENTS_PATH, { door, token, fetchImpl });
  return body;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = opts.files.length > 0 ? opts.files : CONFIG_DOCUMENT_FILES;

  if (opts.dryRun) {
    const state = await readSeedState({ door: opts.door });
    if (!state.ready) {
      out(c.red('✘ ') + state.reason);
      process.exitCode = 1;
      return;
    }
    const seeded = new Set((state.documents ?? []).map((row) => row.file));
    for (const file of files) {
      out(
        seeded.has(file)
          ? `${c.dim('·')} ${file} ${c.dim('already seeded')}`
          : `${c.green('+')} ${file} ${c.dim('would be seeded')}`,
      );
    }
    return;
  }

  const { status, body, absent } = await runSeed({
    files,
    force: opts.force,
    reason: opts.reason,
    door: opts.door,
  });
  for (const line of seedReport(body, { absent })) out(line);
  process.exitCode = status === 200 && (body.refused?.length ?? 0) === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${c.red('✘')} ${error.message}\n`);
    process.exitCode = 1;
  });
}
