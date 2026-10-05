// Bing Webmaster Tools' AI Performance export — the format contract.
//
// WHY THIS IS AN IMPORT AND NOT A COLLECTOR. The AI Performance report (public
// preview) is the only place Microsoft says which questions its assistants
// answered with this property's pages. It exists in the dashboard and in a CSV
// download button, and nowhere on the documented `IWebmasterApi` surface
// (docs/11 §"Bing AI Performance boundary"), so there is no lane to poll and
// scraping the dashboard is ruled out on principle. The operator downloads a
// file; this module is what turns that file into evidence.
//
// PINNED TO THE FORMAT WE ACTUALLY OBSERVED, NOT TO A GUESS. Every column name,
// the date spelling, the percent suffix and the digits-only counts below were
// read off three real exports delivered 2026-08-04 (bead ro-2dn). A file whose
// header row is not one of the three is REFUSED — never mapped by position,
// never partially read. That refusal is the whole reason the bead waited for a
// real file: a parser that guesses a column is how a silent corruption starts,
// and the citation counts here are about to sit next to GSC clicks.
//
// WHAT AN ARCHIVE HOLDS. One dropped file becomes one archive: the original
// bytes, base64 and byte-identical, PLUS the rows this parser made of them. The
// bytes are the source of record — any later parser can redo the read without
// asking the operator to download 2026 again — and the rows are what the panel
// flattener consumes, so the CSV in the panel dir can never drift from a parse
// nobody kept.
//
// THE EXPORT DATE IS THE REPORT DATE. Two of the three exports carry no date
// column at all: they are period snapshots of "the report as of today", and
// Bing's own filename is the only place their date lives. So the caller stamps
// the export date (`scripts/bing-ai-import.mjs` reads it off the filename) and
// the archive is keyed on it. Re-importing the same file replaces its archive;
// a later export lands beside it as the next dated observation. The daily
// overview series is imported the same way — one archive per export, carrying
// the whole series — and the flattener resolves an overlapping day to the
// newest export (scripts/signal-archive.mjs), because a repeated Bing
// snapshot is a revision, never an increment.

import { parseCsv } from './csv.js';
import type { CollectedDump } from './signal-dumps.js';

/** The store's integration id. These rows ARE Bing Webmaster Tools — the same
 * account, the same verified site — so they share the integration and are told
 * apart by report family. (`signal_dump_runs.integration` is a closed CHECK
 * list; a new value would need a migration to say something already true.) */
export const BING_AI_INTEGRATION = 'bing-webmaster';

/** No credential crosses this lane: a human signed in and clicked Export. */
export const BING_AI_CREDENTIAL_REF = 'operator-export';

/** Bumped when the parse below changes shape. Stored on every archive so a row
 * can always be traced to the reader that produced it. */
export const BING_AI_PARSER_VERSION = 'bing-ai-export/1';

/**
 * The largest file this lane accepts.
 *
 * The three observed exports are 3 KB, 11 KB and 55 KB; the ceiling is three
 * orders of magnitude above that so a much larger portfolio still fits, while
 * an accidental drop of the wrong file (a database backup, a video) is refused
 * at the door instead of being base64'd into R2.
 */
export const BING_AI_EXPORT_MAX_BYTES = 4 * 1024 * 1024;

export type BingAiReport = 'ai-overview' | 'ai-queries' | 'ai-pages';

/** A refusal an operator can act on: the code names the fault, the message says
 * which file, which row and what was expected. */
export class BingAiExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BingAiExportError';
  }
}

export interface BingAiFormat {
  /** The report family it lands in (`signal_dump_runs.report`). */
  report: BingAiReport;
  /** Bing's own name for the export, as it appears in the download filename. */
  exportName: string;
  /** The header row, verbatim and in order. Anything else is a different file. */
  header: readonly string[];
  /** What one row of the flattened family means. Rendered in refusals and docs. */
  grain: string;
  /** One data row, already checked for arity. */
  row(cells: readonly string[]): Record<string, string | number>;
}

/**
 * Bing writes midnight local time onto a date-only series. The time is part of
 * the format, so it is matched rather than ignored: a future export carrying a
 * real time of day would mean the grain changed under us, and that must be a
 * loud refusal rather than a silently truncated hour.
 */
const OVERVIEW_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) 12:00:00 AM$/;
const PERCENT_RE = /^(\d+(?:\.\d+)?)%$/;
const COUNT_RE = /^\d+$/;

function fail(code: string, message: string): never {
  throw new BingAiExportError(code, message);
}

/** `M/D/YYYY 12:00:00 AM` → `YYYY-MM-DD`, or a refusal. */
export function bingAiDay(value: string): string {
  const match = OVERVIEW_DATE_RE.exec(value.trim());
  if (!match) {
    fail(
      'bing_ai_export_bad_date',
      `"${value}" is not the M/D/YYYY 12:00:00 AM date this export has always used. ` +
        'The date spelling is pinned, not sniffed — reread the format before importing.',
    );
  }
  const [, month, day, year] = match as unknown as [string, string, string, string];
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  // A calendar check, not a regex one: 2/30/2026 matches the shape and is not a
  // day, and a series with a day that never happened is worse than a refusal.
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    fail('bing_ai_export_bad_date', `"${value}" is not a real calendar date.`);
  }
  return iso;
}

/**
 * A citation count. Digits only — the export has never written a thousands
 * separator, and `Number.parseInt('1,234')` is 1, which would land a 200x
 * understatement in the panel without a single error.
 */
export function bingAiCount(value: string, column: string): number {
  const text = value.trim();
  if (!COUNT_RE.test(text)) {
    fail(
      'bing_ai_export_bad_count',
      `${column} carried "${value}", which is not a whole number of citations. ` +
        'This parser refuses rather than coerce: a separator or a decimal here would ' +
        'silently change the count.',
    );
  }
  const count = Number(text);
  if (!Number.isSafeInteger(count)) {
    fail('bing_ai_export_bad_count', `${column} carried "${value}", which is too large to count.`);
  }
  return count;
}

/** `"27.24%"` → `27.24` (percentage points, not a fraction). */
export function bingAiPercent(value: string, column: string): number {
  const match = PERCENT_RE.exec(value.trim());
  if (!match) {
    fail(
      'bing_ai_export_bad_percent',
      `${column} carried "${value}", which is not the "12.34%" share string this export writes.`,
    );
  }
  return Number(match[1]);
}

function required(value: string | undefined, column: string): string {
  const text = (value ?? '').trim();
  if (text === '') {
    fail('bing_ai_export_missing_value', `${column} was empty, and it identifies the row.`);
  }
  return text;
}

/** Optional descriptive text. Empty stays empty: Bing not labelling a query's
 * intent is an absence, and inventing one would be a claim. */
function optional(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * The three exports of Bing's AI Performance report, as downloaded 2026-08-04.
 *
 * Adding a fourth means downloading a real one first. That is the rule this
 * whole lane exists to keep.
 */
export const BING_AI_FORMATS: readonly BingAiFormat[] = [
  {
    report: 'ai-overview',
    exportName: 'AIPerformanceOverviewStats',
    header: ['Date', 'Citations', 'Cited Pages'],
    grain: 'one completed day of property-wide AI citations',
    row: (cells) => ({
      date: bingAiDay(required(cells[0], 'Date')),
      citations: bingAiCount(required(cells[1], 'Citations'), 'Citations'),
      citedPages: bingAiCount(required(cells[2], 'Cited Pages'), 'Cited Pages'),
    }),
  },
  {
    report: 'ai-queries',
    exportName: 'AISearchQueriesReport',
    header: ['Grounding Query', 'Intent', 'Topic', 'Citations', 'Citation Share'],
    grain: 'one grounding query over the export period',
    row: (cells) => ({
      query: required(cells[0], 'Grounding Query'),
      intent: optional(cells[1]),
      topic: optional(cells[2]),
      citations: bingAiCount(required(cells[3], 'Citations'), 'Citations'),
      citationSharePercent: bingAiPercent(required(cells[4], 'Citation Share'), 'Citation Share'),
    }),
  },
  {
    report: 'ai-pages',
    exportName: 'AIPageStatsReport',
    header: ['Page', 'Citations'],
    grain: 'one cited page over the export period',
    row: (cells) => ({
      page: required(cells[0], 'Page'),
      citations: bingAiCount(required(cells[1], 'Citations'), 'Citations'),
    }),
  },
];

function describeFormats(): string {
  return BING_AI_FORMATS.map(
    (format) => `${format.exportName} [${format.header.join(', ')}]`,
  ).join('; ');
}

/**
 * Which of the three exports this header IS — exactly, or not at all.
 *
 * No prefix match, no subset, no reordering. A header that has gained a column
 * is a report Microsoft changed, and the right answer is a refusal that names
 * what arrived so a human can decide, not a parse that quietly drops it.
 */
export function detectBingAiFormat(header: readonly string[]): BingAiFormat {
  const match = BING_AI_FORMATS.find(
    (format) =>
      format.header.length === header.length &&
      format.header.every((name, index) => name === header[index]),
  );
  if (!match) {
    fail(
      'bing_ai_export_unknown_format',
      `Unrecognized header [${header.join(', ')}]. This importer reads exactly three Bing ` +
        `AI Performance exports: ${describeFormats()}. It refuses everything else rather ` +
        'than guess which column is which.',
    );
  }
  return match;
}

export interface BingAiExportParse {
  report: BingAiReport;
  exportName: string;
  grain: string;
  header: string[];
  rows: Record<string, string | number>[];
}

/** The UTF-8 BOM every one of these exports opens with. Stripped for parsing;
 * the archived bytes keep it. Built from its code point because an invisible
 * character in source is a thing nobody can review. */
const BOM = String.fromCharCode(0xfeff);

/**
 * One export file's text, parsed.
 *
 * A ragged row is a refusal, not a padded row: the file is machine-written, so
 * a short line means something is wrong with the file or with this reader, and
 * either way the honest move is to stop.
 */
export function parseBingAiExport(text: string): BingAiExportParse {
  const grid = parseCsv(text.startsWith(BOM) ? text.slice(BOM.length) : text).filter(
    (cells) => !(cells.length === 1 && cells[0]!.trim() === ''),
  );
  if (grid.length === 0) {
    fail('bing_ai_export_empty', 'The file has no rows at all, not even a header.');
  }
  const header = grid[0]!.map((name) => name.trim());
  const format = detectBingAiFormat(header);
  const rows = grid.slice(1).map((cells, index) => {
    if (cells.length !== header.length) {
      fail(
        'bing_ai_export_ragged_row',
        `Row ${index + 2} has ${cells.length} field(s); the header declares ${header.length}.`,
      );
    }
    return format.row(cells);
  });
  return {
    report: format.report,
    exportName: format.exportName,
    grain: format.grain,
    header,
    rows,
  };
}

/**
 * The filename's own claim about which export it is, checked against the header.
 *
 * Bing names the download `<site>_<ExportName>_<M_D_YYYY>.csv`. When that name
 * is present and disagrees with the header, somebody renamed or re-saved a
 * file, and the two facts about what this is no longer agree — which is exactly
 * the moment to stop, because the export date is read off that same filename.
 * A filename carrying no recognizable export name is fine: the header decides.
 */
export function assertFilenameAgrees(file: string, format: BingAiFormat): void {
  const claimed = BING_AI_FORMATS.filter((candidate) => file.includes(candidate.exportName));
  if (claimed.length === 0) return;
  if (claimed.length === 1 && claimed[0] === format) return;
  fail(
    'bing_ai_export_filename_mismatch',
    `"${file}" names ${claimed.map((candidate) => candidate.exportName).join(' and ')}, ` +
      `but its header is ${format.exportName}'s. The export date is read off that filename, ` +
      'so the two must agree — re-download the file rather than rename it.',
  );
}

function base64Encode(bytes: Uint8Array): string {
  // Chunked: spreading a multi-megabyte array into String.fromCharCode blows
  // the argument limit, and this ceiling is 4 MiB.
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', owned));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface BingAiDumpInput {
  file: string;
  exportDate: string;
  bytes: Uint8Array;
  fileSha256: string;
  parse: BingAiExportParse;
}

/**
 * The archive payload for one dropped export.
 *
 * Everything in here is a fact about the FILE, not about the moment it was
 * imported: the same file dropped twice produces byte-identical content, so the
 * archive's content hash matches and the second import is recorded `unchanged`
 * against the object the first one wrote. That is what makes "run it again if
 * you are not sure" safe.
 */
export function bingAiCollectedDump(input: BingAiDumpInput): CollectedDump {
  const { file, exportDate, bytes, fileSha256, parse } = input;
  return {
    pages: [
      {
        request: {
          source: 'operator-export',
          provider: 'bing-webmaster-ai-performance',
          exportName: parse.exportName,
          exportDate,
          file,
          fileSha256,
          fileBytes: bytes.byteLength,
          header: parse.header,
          parser: BING_AI_PARSER_VERSION,
          grain: parse.grain,
        },
        response: {
          // The original, byte for byte, so any later reader can redo the parse
          // without the operator downloading history that no longer exists.
          csvBase64: base64Encode(bytes),
          rows: parse.rows,
        },
      },
    ],
    providerRows: parse.rows.length,
    // Nothing paginates here: the file is whatever Bing's UI wrote. If the
    // dashboard ever caps an export, that cap is invisible to us and would be a
    // fact about the download, not something this lane can detect.
    providerTruncated: false,
  };
}
