#!/usr/bin/env node
// Download the latest immutable raw-signal object for each selected report day.
//
// Decompressed JSON lands under .local/ (gitignored).
//
// It does not open the store. Both reads go through the loopback ingest door:
// GET /api/signal-archives (the manifest, filtered as asked) and
// GET /api/panel-object (one archive, decompressed), served by the one runtime
// that owns the file.
//
// --remote is refused (REMOTE_REFUSED): this tool reaches the store only
// through the ingest, never with a database credential.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DOOR, doorRequest, doorUrl, operatorToken } from './ingest-door.mjs';
import { readDownloadsManifest } from './signal-downloads.mjs';
import { mergeManifest } from './signal-panels-refresh.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What `--remote` answers: nothing is read. */
export const REMOTE_REFUSED =
  '--remote reads nothing now: the reports are in the installation\'s own store, reached through its ingest (--door). Nothing downloaded.';

/** The integrations whose archives this tool may be narrowed to. PostHog is
 * six aggregate families, one archive per family per window end, flattened by
 * `signal-history-analyze.mjs` into `posthog-<family>.csv`. */
export const DOWNLOADABLE_INTEGRATIONS = [
  'ga4',
  'gsc',
  'bing-webmaster',
  'dataforseo',
  'clarity',
  'posthog',
];

function usage() {
  console.log(`Usage:
  pnpm signals:download -- --asset example.com [filters]

Filters:
  --asset <id>          required property id
  --from <YYYY-MM-DD>   earliest report date
  --to <YYYY-MM-DD>     latest report date
  --integration <id>    ga4, gsc, bing-webmaster, dataforseo, clarity, or posthog
  --report <name>       one report family
  --out <directory>     default .local/signal-dumps/downloads
  --door <url>          local ingest base url (default ${DEFAULT_DOOR})
`);
}

export function parseArgs(argv) {
  const options = {
    asset: null,
    from: null,
    to: null,
    integration: null,
    report: null,
    out: path.join(REPO_ROOT, '.local', 'signal-dumps', 'downloads'),
    door: DEFAULT_DOOR,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--remote') throw new Error(REMOTE_REFUSED);
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} needs a value.`);
    if (arg === '--asset') options.asset = value;
    else if (arg === '--from') options.from = value;
    else if (arg === '--to') options.to = value;
    else if (arg === '--integration') options.integration = value;
    else if (arg === '--report') options.report = value;
    else if (arg === '--out') options.out = path.resolve(REPO_ROOT, value);
    else if (arg === '--door') options.door = value;
    else throw new Error(`Unknown option: ${arg}`);
    index++;
  }
  if (!options.asset || !/^[a-z0-9.-]+$/.test(options.asset)) {
    throw new Error('--asset is required and must be a property id such as example.com.');
  }
  if (options.integration && !DOWNLOADABLE_INTEGRATIONS.includes(options.integration)) {
    throw new Error(
      '--integration must be ga4, gsc, bing-webmaster, dataforseo, clarity, or posthog.',
    );
  }
  if (options.report && !/^[a-z0-9-]+$/.test(options.report)) {
    throw new Error('--report must contain only lowercase letters, numbers, and hyphens.');
  }
  for (const [name, value] of [
    ['--from', options.from],
    ['--to', options.to],
  ]) {
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`${name} must be YYYY-MM-DD.`);
    }
  }
  return options;
}

/**
 * The manifest — one row per (integration, report, report day), newest
 * surviving revision only.
 *
 * The local answer comes back without `asset` (the route already knows which
 * property was asked for), so it is put back here: the rows are written into
 * manifest.json and read by anything that opens the panel dir, and a row that
 * cannot name its property is a row nobody can join.
 */
async function queryManifests(options, deps) {
  const response = await doorRequest(
    deps.get,
    doorUrl(options.door, 'api/signal-archives', {
      asset: options.asset,
      from: options.from,
      to: options.to,
      integration: options.integration,
      report: options.report,
    }),
    { token: deps.token },
  );
  const body = await response.json();
  const rows = Array.isArray(body?.manifest) ? body.manifest : [];
  return rows.map((row) => ({ asset: options.asset, ...row }));
}

/**
 * One archive on disk.
 *
 * Local goes through the door, which hands back the decompressed JSON the
 * runtime read out of R2 — the same bytes, unwrapped by the process that owns
 * the bucket binding. Parsed before it is written, because a truncated body
 * would flatten into a CSV that reads as real missing rows. The trailing
 * newline matches `signal-panels-refresh.mjs`, so a hand download and a standing
 * refresh leave byte-identical files.
 */
async function downloadObject(row, options, deps) {
  const destination = path.join(
    options.out,
    row.asset,
    row.integration,
    row.report,
    `${row.reportDate}.json`,
  );
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const response = await doorRequest(
    deps.get,
    doorUrl(options.door, 'api/panel-object', { key: row.objectKey }),
    { token: deps.token },
  );
  const body = await response.text();
  JSON.parse(body);
  await fs.writeFile(destination, body.endsWith('\n') ? body : `${body}\n`);
  return destination;
}

/**
 * One download pass. Every side effect is injectable so the lane can be tested
 * without a running OS: `get` is the door's fetch, `token` the operator bearer
 * (read from the dev-secrets file when the caller does not supply one).
 */
export async function downloadSignalDumps(options, deps = {}) {
  const resolved = {
    get: deps.get ?? fetch,
    token: deps.token ?? await operatorToken(),
  };

  const rows = await queryManifests(options, resolved);
  if (rows.length === 0) {
    console.log('No local signal dumps matched.');
    return { rows: [], files: [] };
  }

  const files = [];
  for (const row of rows) {
    const destination = await downloadObject(row, options, resolved);
    files.push(destination);
    console.log(
      `Downloaded ${row.reportDate} ${row.integration}/${row.report} → ${path.relative(REPO_ROOT, destination)}`,
    );
  }
  // The manifest keeps every report day an earlier download or refresh
  // recorded, merged by the refresh's own rule: the archives stay
  // on disk, and a filtered pass that dropped their rows would lose the later
  // confirmation that settles a GA4 day, so it would read provisional again.
  const assetDir = path.join(options.out, options.asset);
  const previous = await readDownloadsManifest(assetDir);
  const objects = mergeManifest(Array.isArray(previous?.objects) ? previous.objects : [], rows);
  const manifestPath = path.join(assetDir, 'manifest.json');
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        downloadedAt: new Date().toISOString(),
        source: 'local',
        asset: options.asset,
        filters: {
          from: options.from,
          to: options.to,
          integration: options.integration,
          report: options.report,
        },
        objects,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Wrote ${rows.length} archive(s) and ${path.relative(REPO_ROOT, manifestPath)}.`);
  return { rows, files };
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    await downloadSignalDumps(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exitCode = 1;
  }
}
