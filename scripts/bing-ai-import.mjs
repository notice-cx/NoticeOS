#!/usr/bin/env node
// bing-ai-import.mjs — drop a Bing AI Performance export anywhere, run one
// command, and it becomes evidence (bead ro-2dn).
//
//   pnpm bing-ai:import ~/Downloads/example.com_AIPageStatsReport_8_4_2026.csv
//
// WHY A HAND-DROPPED FILE AT ALL. Bing Webmaster Tools' AI Performance report —
// which questions Microsoft's assistants answered with this property's pages,
// and which pages they cited — exists in the dashboard and behind an Export
// button, and nowhere on the documented API surface (docs/11 §"Bing AI
// Performance boundary"). Scraping the dashboard is ruled out on principle. So
// the operator downloads a file and this is the whole of what they have to do
// with it: name the path.
//
// WHAT IT DOES NOT DO. It does not open the store. The archive is written by the
// one runtime that owns the local sqlite file, over the loopback ingest door
// (`POST /api/bing-ai-export`), for the same reason every other lane here does:
// a second workerd over that file is the 2026-08-02 corruption (beads ro-mad,
// ro-icq; scripts/no-second-runtime.test.mjs is what keeps it true).
//
// WHAT IT REFUSES. The FORMAT is decided by the header row on the far side and
// an unrecognized header is a loud refusal — this bead exists because a parser
// that guesses a column is how a silent corruption starts. The ASSET and the
// EXPORT DATE are read off Bing's own filename (`<site>_<Report>_<M_D_YYYY>.csv`),
// and a file renamed past recognition is refused here with the two flags that
// fix it rather than imported under a guess.
//
// RUNNING IT TWICE IS SAFE. The archive is content-addressed over the file, so
// re-importing the same export answers `unchanged` and writes no second copy.
// A later export lands on its own export date and extends the dated series;
// where two exports overlap a day, the panel resolves the day to the newest
// one (scripts/signal-archive.mjs). Nothing double-counts.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DOOR, doorRequest, doorUrl, operatorToken } from './ingest-door.mjs';
import {
  parseArgs as parsePanelArgs,
  refreshPanels,
} from './signal-panels-refresh.mjs';

export { DEFAULT_DOOR };

/**
 * How Bing names the download: `<site>_<ExportName>_<M>_<D>_<YYYY>.csv`.
 *
 * Two of the three exports carry no date column anywhere in the file, so this
 * filename is the ONLY place their date lives — which is exactly why a file
 * whose name no longer matches is refused instead of stamped with today.
 */
export const EXPORT_FILE_RE =
  /^(?<asset>[a-z0-9][a-z0-9.-]*)_(?<exportName>[A-Za-z0-9]+)_(?<month>\d{1,2})_(?<day>\d{1,2})_(?<year>\d{4})\.csv$/;

function usage() {
  console.log(`Usage:
  pnpm bing-ai:import <file.csv> [more files...] [options]

Drops a Bing Webmaster AI Performance export into the archive and refreshes the
property's panel dir. The asset and export date come from Bing's own filename.

Options:
  --asset <id>          override the property id read from the filename
  --export-date <YYYY-MM-DD>
                        override the export date read from the filename
                        (one file at a time — it is a fact about that file)
  --door <url>          ingest base url (default ${DEFAULT_DOOR})
  --no-refresh          archive only; do not rebuild the panel dir
`);
}

export function parseArgs(argv) {
  const options = {
    files: [],
    asset: null,
    exportDate: null,
    door: DEFAULT_DOOR,
    refresh: true,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--no-refresh') {
      options.refresh = false;
      continue;
    }
    if (!arg.startsWith('--')) {
      options.files.push(arg);
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} needs a value.`);
    if (arg === '--asset') options.asset = value;
    else if (arg === '--export-date') options.exportDate = value;
    else if (arg === '--door') options.door = value;
    else throw new Error(`Unknown option: ${arg}`);
    index++;
  }
  if (options.files.length === 0) {
    throw new Error('Name at least one exported CSV file to import.');
  }
  if (options.asset !== null && !/^[a-z0-9.-]+$/.test(options.asset)) {
    throw new Error('--asset must be a property id such as example.com.');
  }
  if (options.exportDate !== null && !isCalendarDate(options.exportDate)) {
    throw new Error('--export-date must be a real YYYY-MM-DD date.');
  }
  if (options.exportDate !== null && options.files.length > 1) {
    throw new Error(
      '--export-date names the day ONE file was exported; import the files one at a time ' +
        'rather than stamping several with the same date.',
    );
  }
  return options;
}

export function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** What Bing's filename says this file is, or null when it says nothing. */
export function describeExportFile(basename) {
  const match = EXPORT_FILE_RE.exec(basename);
  if (!match) return null;
  const { asset, exportName, month, day, year } = match.groups;
  const exportDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  if (!isCalendarDate(exportDate)) return null;
  return { asset, exportName, exportDate };
}

/**
 * The property and export date this import will use — from the flags where the
 * operator gave them, from the filename otherwise, and a refusal that names the
 * missing flag when neither answers.
 *
 * A guess here would be the worst kind: the export date is what the whole dated
 * series is keyed on, so a wrong one silently rewrites which day a snapshot
 * describes, and a wrong asset files one property's citations under another.
 */
export function resolveImport(file, options) {
  const basename = path.basename(file);
  const named = describeExportFile(basename);
  const asset = options.asset ?? named?.asset ?? null;
  const exportDate = options.exportDate ?? named?.exportDate ?? null;
  if (asset === null || exportDate === null) {
    const missing = [
      asset === null ? '--asset <property id>' : null,
      exportDate === null ? '--export-date <YYYY-MM-DD>' : null,
    ].filter(Boolean);
    throw new Error(
      `"${basename}" is not named the way Bing names an export ` +
        '(<site>_<Report>_<M_D_YYYY>.csv), so this importer cannot read ' +
        `${missing.join(' and ')} off it. Re-download the file, or pass ${missing.join(' and ')} ` +
        'explicitly — the export date is the only date these snapshots have, and guessing it ' +
        'would misdate the series.',
    );
  }
  return { file, basename, asset, exportDate, exportName: named?.exportName ?? null };
}

/** One file, through the door. Returns what the store did with it. */
export async function importExport(resolved, deps) {
  const { get = fetch, token, door = DEFAULT_DOOR, readFile = fs.readFile } = deps;
  const bytes = await readFile(resolved.file);
  const response = await doorRequest(get, doorUrl(door, 'api/bing-ai-export'), {
    token,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      asset: resolved.asset,
      file: resolved.basename,
      exportDate: resolved.exportDate,
      contentBase64: Buffer.from(bytes).toString('base64'),
    }),
  });
  return response.json();
}

/** The line the operator reads. `unchanged` is not a failure and must not look
 * like one: it means this exact file was already archived for that day. */
export function importLine(result) {
  const verb = result.status === 'unchanged' ? 'already held' : 'archived';
  return (
    `${result.file}: ${verb} ${result.rows} row(s) as ${result.report} ` +
    `for ${result.asset} on ${result.exportDate}` +
    (result.objectKey ? ` → ${result.objectKey}` : '')
  );
}

export async function importBingAiExports(options, deps = {}) {
  const token = deps.token ?? (await operatorToken());
  const imported = [];
  for (const file of options.files) {
    const resolved = resolveImport(path.resolve(process.cwd(), file), options);
    const result = await importExport(resolved, { ...deps, token, door: options.door });
    imported.push(result);
    console.log(importLine(result));
  }

  if (!options.refresh) return { imported, refreshed: [] };

  // The panel dir is the only surface a property agent reads (docs/20), so an
  // import that stopped at the archive would be invisible to the reader it was
  // collected for. This is the SAME refresh the 13:10 cron runs, scoped to the
  // properties this run touched, and it costs zero provider calls.
  const refreshed = [];
  for (const asset of [...new Set(imported.map((result) => result.asset))]) {
    const { failures } = await refreshPanels(
      parsePanelArgs(['--asset', asset, '--door', options.door]),
      { token },
    );
    refreshed.push({ asset, failures });
  }
  return { imported, refreshed };
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    const { refreshed } = await importBingAiExports(parseArgs(process.argv.slice(2)));
    if (refreshed.some((entry) => entry.failures.length > 0)) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exitCode = 1;
  }
}
