// A DOWNLOADS FOLDER AS THE ARCHIVE'S READERS SEE IT (beads ro-ujb9.67.1,
// ro-ujb9.67.2).
//
// `signals:download` and `signals:refresh` write one site's archives as
// `<integration>/<report>/<reportDate>.json` beside a `manifest.json`. Two
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
