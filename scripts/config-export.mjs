#!/usr/bin/env node
// config-export.mjs — write the store's config documents into this
// installation's folder (epic `ro-syok`, db/0029; bead ro-ujb9.125).
//
// WHERE. `installation/` by default, or `NOTICEOS_INSTALLATION_DIR`
// (scripts/installation.mts). Never `config/`: those are the product's generic
// defaults, and one installation's settings are not the product's.
//
// THIS IS WHAT KEEPS docs/06's PROMISE. Config moved into the store so a
// deployed Tower could save a setting, and the rule that made file config worth
// choosing — anything that can change a verdict is visible in a diff — survives
// because the files are still there and this command refreshes them. A commit of
// what this writes is the same audit artifact the repo has always carried;
// `config_changes` is the machine-readable half beside it.
//
// IT WRITES THE SAME BYTES A SAVE WOULD. `serializeDocument` is the one spelling
// a document is written in — 2-space JSON, trailing newline — so an export of an
// unchanged store leaves the checkout byte-identical and an export never looks
// like a change it did not make.
//
//   pnpm config:export
//   pnpm config:export --file config/tower.json     # just one
//   flags: --door <url>  --check
//
// `--check` writes nothing and answers whether the checkout already matches the
// store, which is what a pre-commit or a runbook step wants.
//
// IT NEVER COMMITS. Where those commits go is the operator's business, exactly
// as it is for `pnpm config:apply` and the Tower's write lane.
//
// Plain Node ESM — no TypeScript, no build step, no dependencies.

import { CONFIG_DOCUMENT_FILES, serializeDocument } from './config-documents.mjs';
import { readInstalledDocument, writeDocumentFile } from './config-apply-core.mjs';
import { checkoutRelative, installationPath } from './installation.mjs';
import {
  CONFIG_DOCUMENTS_PATH,
  DEFAULT_DOOR,
  configStoreRequest,
} from './config-store-client.mjs';

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
  const opts = { files: [], door: DEFAULT_DOOR, check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') opts.files.push(argv[++i]);
    else if (arg === '--door') opts.door = argv[++i];
    else if (arg === '--check') opts.check = true;
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  const unknown = opts.files.filter((file) => !CONFIG_DOCUMENT_FILES.includes(file));
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.join(', ')} is not a config document — the OS knows ${CONFIG_DOCUMENT_FILES.join(', ')}`,
    );
  }
  return opts;
}

/** Every document the store holds, bodies included. */
export async function readStoredDocuments({ door = DEFAULT_DOOR, token, fetchImpl = fetch } = {}) {
  const { body } = await configStoreRequest(CONFIG_DOCUMENTS_PATH, {
    door,
    token,
    fetchImpl,
    params: { bodies: '1' },
  });
  return body;
}

/**
 * What an export would do to this installation's folder, per document, WITHOUT
 * writing anything.
 *
 * Three answers only: `written` (the installation's copy differs from the
 * store, or it has none yet), `same` (byte for byte already), and `unseeded`
 * (the store holds no document, so the file is still the source and this
 * command has nothing to say about it). The product default in `config/` is
 * never compared or written: an export is this installation's own
 * (bead ro-ujb9.125). `path` is the file an export writes.
 */
export async function planExport(stored, files, { repoRoot } = {}) {
  const byFile = new Map((stored.documents ?? []).map((row) => [row.file, row]));
  const where = repoRoot === undefined ? {} : { root: repoRoot };
  const plan = [];
  for (const file of files) {
    const at = checkoutRelative(installationPath(file, where), where);
    const row = byFile.get(file);
    if (row === undefined) {
      plan.push({ file, path: at, action: 'unseeded' });
      continue;
    }
    const next = serializeDocument(row.body);
    const current = await readInstalledDocument(file, repoRoot === undefined ? {} : { repoRoot });
    const same = current !== null && serializeDocument(current) === next;
    plan.push({ file, path: at, action: same ? 'same' : 'written', version: row.version, body: row.body });
  }
  return plan;
}

export function exportReport(plan, { check = false } = {}) {
  const lines = [];
  for (const row of plan) {
    if (row.action === 'written') {
      lines.push(
        check
          ? `${c.yellow('!')} ${row.path ?? row.file} ${c.dim(`differs from the store (version ${row.version})`)}`
          : `${c.green('✓')} ${row.path ?? row.file} ${c.dim(`← version ${row.version}`)}`,
      );
    } else if (row.action === 'same') {
      lines.push(`${c.dim('·')} ${row.path ?? row.file} ${c.dim('already matches the store')}`);
    } else {
      lines.push(`${c.dim('·')} ${row.file} ${c.dim('is not in the store — the file is the source')}`);
    }
  }
  if (lines.length === 0) lines.push(c.dim('· nothing to export'));
  return lines;
}

export async function runExport({
  files = CONFIG_DOCUMENT_FILES,
  door = DEFAULT_DOOR,
  token,
  fetchImpl = fetch,
  repoRoot,
  check = false,
} = {}) {
  const stored = await readStoredDocuments({ door, token, fetchImpl });
  if (!stored.ready) return { ready: false, reason: stored.reason, plan: [] };
  const plan = await planExport(stored, files, { repoRoot });
  if (!check) {
    for (const row of plan) {
      if (row.action !== 'written') continue;
      await writeDocumentFile(row.file, row.body, repoRoot === undefined ? {} : { repoRoot });
    }
  }
  return { ready: true, reason: null, plan };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = opts.files.length > 0 ? opts.files : CONFIG_DOCUMENT_FILES;
  const { ready, reason, plan } = await runExport({
    files,
    door: opts.door,
    check: opts.check,
  });
  if (!ready) {
    out(c.red('✘ ') + reason);
    process.exitCode = 1;
    return;
  }
  for (const line of exportReport(plan, { check: opts.check })) out(line);
  // `--check` is a gate: a checkout behind the store is a failure a runbook step
  // wants to hear about, while an ordinary export writing files is a success.
  process.exitCode =
    opts.check && plan.some((row) => row.action === 'written') ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${c.red('✘')} ${error.message}\n`);
    process.exitCode = 1;
  });
}
