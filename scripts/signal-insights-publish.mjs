#!/usr/bin/env node
// Publish one compact executive snapshot into the store's presentation
// boundary. Raw provider rows stay in R2; the Tower never reads local files or
// the archive bucket at request time.
//
// It does not open the store: the local publish POSTs to the ingest's
// operator-authed route on the loopback door, so the one runtime that owns
// the store does the write. --remote is refused (REMOTE_REFUSED): this tool
// reaches the store only through the ingest, never with a database credential.
//
// The row is content-addressed over the exact bytes sent, so re-publishing an
// unchanged file is a no-op and says so.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DOOR, doorRequest, doorUrl, operatorToken } from './ingest-door.mjs';
import { PANEL_REPORTS_DIRECTORY, panelReportPath } from './signal-panel-paths.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What `--remote` answers: nothing is written. */
export const REMOTE_REFUSED =
  '--remote writes nothing now: a snapshot goes into the installation\'s own store through its ingest (--door). Nothing published.';

function usage() {
  console.log(`Usage:
  pnpm signals:publish-insights -- --asset example.com [options]

Options:
  --asset <id>      required property id
  --file <path>     default ${PANEL_REPORTS_DIRECTORY}/<asset>/executive.json
  --door <url>      local ingest base url (default ${DEFAULT_DOOR})
`);
}

export function parseArgs(argv) {
  let asset = null;
  let file = null;
  let door = DEFAULT_DOOR;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--remote') throw new Error(REMOTE_REFUSED);
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} needs a value.`);
    if (arg === '--asset') asset = value;
    else if (arg === '--file') file = path.resolve(REPO_ROOT, value);
    else if (arg === '--door') door = value;
    else throw new Error(`Unknown option: ${arg}`);
    index++;
  }
  if (!asset || !/^[a-z0-9.-]+$/.test(asset)) {
    throw new Error('--asset is required and must be a property id such as example.com.');
  }
  return {
    asset,
    file: file ?? path.join(panelReportPath(asset), 'executive.json'),
    door,
  };
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

/**
 * The shape check that happens BEFORE anything leaves this machine.
 *
 * The ingest route validates the same fields — it has to, since an HTTP body is
 * untrusted — but a local file that belongs to another property, or that the
 * analyzer wrote half of, should fail here with a sentence about the file the
 * operator named, not as a 422 about a payload they never saw.
 */
function validateSnapshot(value, asset) {
  const snapshot = record(value);
  if (
    !snapshot ||
    snapshot.schemaVersion !== 1 ||
    snapshot.asset !== asset ||
    typeof snapshot.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.generatedAt)) ||
    !Array.isArray(snapshot.items) ||
    !Array.isArray(snapshot.methodology) ||
    !snapshot.methodology.every((line) => typeof line === 'string') ||
    !Number.isInteger(snapshot.sourceArchiveCount) ||
    snapshot.sourceArchiveCount < 0
  ) {
    throw new Error('Snapshot is malformed, unsupported, or belongs to another property.');
  }
  return snapshot;
}

/** SHA-256 of the exact bytes published — the id the store content-addresses
 * this snapshot by, checked against the ingest's acknowledgement. */
function contentDigest(payload) {
  return createHash('sha256').update(payload).digest('hex');
}

function snapshotId(asset, contentSha256) {
  return `insight:${asset}:${contentSha256.slice(0, 24)}`;
}

/**
 * Publish one generated snapshot, supplied directly or read from a named file.
 *
 * `post` is injectable so the lane is testable without a running OS — and so
 * it can be exercised without ever touching the operator's live store.
 */
export async function publishExecutiveSnapshot({
  asset,
  file,
  snapshot: suppliedSnapshot,
  door = DEFAULT_DOOR,
  post = fetch,
  token = null,
}) {
  if (suppliedSnapshot !== undefined && file !== undefined) {
    throw new Error('Supply a snapshot or a file, not both.');
  }
  const snapshot = validateSnapshot(suppliedSnapshot === undefined
    ? JSON.parse(await fs.readFile(file, 'utf8')) : suppliedSnapshot, asset);
  const payload = JSON.stringify(snapshot);
  const contentSha256 = contentDigest(payload);
  const itemCount = snapshot.items.length;

  const response = await doorRequest(
    post,
    doorUrl(door, 'api/insight-snapshot', {}),
    {
      token: token ?? (await operatorToken()),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    },
  );
  const body = await response.json();
  if (body?.id !== snapshotId(asset, contentSha256)
    || body?.asset !== asset || body?.contentSha256 !== contentSha256
    || typeof body?.generatedAt !== 'string'
    || Date.parse(body.generatedAt) !== Date.parse(snapshot.generatedAt)
    || typeof body?.created !== 'boolean') {
    throw new Error('Publication was not confirmed: the ingest acknowledgement does not match this snapshot.');
  }
  return {
    // The store's own answer, not a locally recomputed guess: if the two ever
    // disagreed about the id, the operator would be told the row they think
    // they wrote rather than the one that exists.
    id: body.id,
    contentSha256: body.contentSha256,
    itemCount,
    created: body.created,
  };
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    const result = await publishExecutiveSnapshot(parseArgs(process.argv.slice(2)));
    console.log(
      `Published ${result.itemCount} executive insights (${result.id}).` +
        (result.created ? '' : ' Already published — nothing changed.'),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exitCode = 1;
  }
}
