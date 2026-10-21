// A downloads folder as the archive's readers see it.
//
// `signals:download` and `signals:refresh` write one site's archives as
// `<integration>/<report>/<reportDate>.json` beside a `manifest.json`.
// The analytical-file writer (scripts/signal-history.mjs) reads this folder
// before the report analyzes a pinned history generation. It must find the
// archives in the same order, because that order is part of the
// archive rules (scripts/signal-archive.mjs: a tie goes to the one read last).
//
//   archiveFiles(directory)           every archive under it, in reading order
//   readDownloadsManifest(directory)  the manifest beside them, or null

import fs from 'node:fs/promises';
import path from 'node:path';

/** The file the download lanes write beside the archives. */
export const DOWNLOADS_MANIFEST = 'manifest.json';

/**
 * Every archive under `directory`, as absolute paths in path order — the
 * reading order. An archive is a regular `.json` file other than the
 * manifest, at any depth; anything else (a note, a compressed copy, a link) is
 * not read.
 */
export async function archiveFiles(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== DOWNLOADS_MANIFEST) {
        files.push(target);
      }
    }
  }
  await walk(directory);
  return files.sort();
}

/** The manifest beside the archives, or null — none, or not readable — for a
 * hand-assembled input. */
export async function readDownloadsManifest(directory) {
  try {
    return JSON.parse(await fs.readFile(path.join(directory, DOWNLOADS_MANIFEST), 'utf8'));
  } catch {
    return null;
  }
}

/** The shared destination for manual downloads and scheduled refreshes. */
export function archivePath(downloadsRoot, asset, row) {
  return path.join(
    downloadsRoot,
    asset,
    row.integration,
    row.report,
    `${row.reportDate}.json`,
  );
}

/**
 * Merge this pass's manifest rows over whatever an earlier pass recorded, by
 * (integration, report, reportDate) with the newer row winning: the panel dir
 * keeps history the window no longer reaches, and dropping the old rows would
 * make the manifest claim the property has no history. `signals:download`
 * writes the same file with this rule.
 */
export function mergeManifest(previous, current) {
  const byKey = new Map();
  for (const row of [...previous, ...current]) {
    if (!row || typeof row !== 'object') continue;
    const { integration, report, reportDate } = row;
    if (typeof integration !== 'string' || typeof report !== 'string') continue;
    if (typeof reportDate !== 'string') continue;
    byKey.set(`${integration}\0${report}\0${reportDate}`, row);
  }
  return [...byKey.values()].sort((a, b) =>
    `${a.reportDate}${a.integration}${a.report}`.localeCompare(
      `${b.reportDate}${b.integration}${b.report}`,
    ),
  );
}

