#!/usr/bin/env node
// A site's OPEN link-outreach targets, written to the file the
// reclamation-match rule reads (`pnpm signals:analyze-history -- --reclamation-targets
// <file>`, scripts/signal-insights.mjs).
//
//   pnpm reclamation:open-targets -- --asset example.com [--out <file>] [--door <url>]
//
// Open is every target not won, skipped or dead. The command reads them from
// the store through the ingest's door (GET /api/reclamation-targets
// ?asset=<site>&open=1, with the operator bearer), never with a database
// credential of its own (bead ro-ujb9.76.5.9).
//
// The file holds the rule's own reading of the answer (`reclamationTargetList`,
// imported, never a second copy of its shape), so the rule reads back exactly
// what was written. A site with no open target gets an empty list, and the
// command says so. A refusal (an unknown site, more open targets than one list
// may carry, a door that does not answer) writes nothing and exits 1.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DOOR, doorRequest, doorUrl, operatorToken } from './ingest-door.mjs';
import { invokedDirectly } from './os-runtime.mjs';
import { reclamationTargetList } from './signal-insights.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The ingest's route (workers/ingest/src/routes/reclamation-targets.ts). */
export const OPEN_TARGETS_ROUTE = 'api/reclamation-targets';

/** Where the export goes when no `--out` names a file. */
export function defaultOutFile(asset) {
  return path.join(REPO_ROOT, '.local', 'reclamation', `${asset}-open.json`);
}

export const USAGE = `usage:
  pnpm reclamation:open-targets -- --asset example.com [--out <file>] [--door <url>]

--asset  required site id
--out    the file to write (default .local/reclamation/<asset>-open.json)
--door   where the ingest answers (default ${DEFAULT_DOOR})`;

export function parseArgs(argv) {
  let asset = null;
  let out = null;
  let door = DEFAULT_DOOR;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') continue;
    const value = argv[index + 1];
    if (!['--asset', '--out', '--door'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    if (!value) throw new Error(`${arg} needs a value.`);
    if (arg === '--asset') asset = value;
    else if (arg === '--out') out = path.resolve(REPO_ROOT, value);
    else door = value;
    index++;
  }
  if (!asset || !/^[a-z0-9.-]+$/.test(asset)) {
    throw new Error('--asset is required and must be a site id such as example.com.');
  }
  return { asset, out: out ?? defaultOutFile(asset), door };
}

/**
 * The site's open targets, as the rule reads them. Anything but a list from
 * the door (the door silent, the bearer refused, an unknown site, too many
 * open targets) throws, naming what the ingest said.
 */
export async function readOpenTargets(asset, { door = DEFAULT_DOOR, token, fetchImpl = fetch } = {}) {
  const response = await doorRequest(fetchImpl, doorUrl(door, OPEN_TARGETS_ROUTE, { asset, open: 1 }), {
    token: token ?? (await operatorToken()),
    method: 'GET',
  });
  const answer = await response.json();
  const targets = Array.isArray(answer?.targets) ? reclamationTargetList(answer.targets) : null;
  if (targets === null) throw new Error(`/${OPEN_TARGETS_ROUTE} did not answer with a list of targets`);
  return targets;
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

/**
 * The command line; returns the exit code. `options` lets the proofs name the
 * operator bearer and the transport; left out, the bearer is this
 * installation's own (scripts/ingest-door.mjs `operatorToken`).
 */
export async function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr, options = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    out.write(`${USAGE}\n`);
    return 0;
  }
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    err.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  let targets;
  try {
    targets = await readOpenTargets(args.asset, { door: args.door, token: options.token, fetchImpl: options.fetchImpl });
  } catch (error) {
    err.write(`Nothing was written: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  writeJsonAtomic(args.out, targets);
  const shown = path.relative(process.cwd(), args.out) || args.out;
  out.write(`${targets.length} open target${targets.length === 1 ? '' : 's'} for ${args.asset} → ${shown}\n`);
  return 0;
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
