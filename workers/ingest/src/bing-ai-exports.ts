// Bing Webmaster Tools' AI Performance export: the format contract. The report
// exists in the dashboard and a CSV download and nowhere on the documented API,
// so the operator downloads a file and this module turns it into evidence.
// Pinned to the format actually observed: a file whose header row is not one
// of the three is refused, never mapped by position or partially read. One
// dropped file becomes one archive holding the original bytes (base64,
// byte-identical) plus the rows this parser made of them. The export date is
// the report date: two of the three exports carry no date column, so the
// caller stamps the date off the filename and the archive is keyed on it;
// re-importing the same file replaces its archive, and a repeated snapshot is a
// revision, never an increment.

import { parseCsv } from './csv.js';
import type { CollectedDump } from './signal-dumps.js';

/** These rows are Bing Webmaster Tools (same account, same verified site), so
 * they share the integration and are told apart by report family. */
export const BING_AI_INTEGRATION = 'bing-webmaster';

/** No credential crosses this lane: a human signed in and clicked Export. */
export const BING_AI_CREDENTIAL_REF = 'operator-export';

/** Bumped when the parse below changes shape; stored on every archive. */
export const BING_AI_PARSER_VERSION = 'bing-ai-export/1';

/**
 * The largest file this lane accepts: three orders of magnitude above the
 * observed exports, so an accidental drop of the wrong file is refused at the
 * door instead of being base64'd into R2.
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
 * the format and matched rather than ignored: an export carrying a real time
 * of day would mean the grain changed, which must be a loud refusal.
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
  // A calendar check, not a regex one: 2/30/2026 matches the shape and is not a day.
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    fail('bing_ai_export_bad_date', `"${value}" is not a real calendar date.`);
  }
  return iso;
}

/**
 * A citation count. Digits only: `Number.parseInt('1,234')` is 1, which would
 * land a 200x understatement without a single error.
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

/** Optional descriptive text. Empty stays empty: inventing a label would be a claim. */
function optional(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * The three exports of Bing's AI Performance report. Adding a fourth means
 * downloading a real one first.
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
 * Which of the three exports this header is: exactly, or not at all. A header
 * that has gained a column is a report Microsoft changed, and the right answer
 * is a refusal that names what arrived.
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
 * character in source cannot be reviewed. */
const BOM = String.fromCharCode(0xfeff);

/**
 * One export file's text, parsed. A ragged row is a refusal, not a padded row:
 * the file is machine-written, so a short line means something is wrong.
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
 * The filename's own claim about which export it is, checked against the
 * header. Bing names the download `<site>_<ExportName>_<M_D_YYYY>.csv`; when
 * the name disagrees with the header somebody renamed or re-saved a file, and
 * the export date is read off that same filename. A filename carrying no
 * recognizable export name is fine: the header decides.
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
  // the argument limit.
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
 * The archive payload for one dropped export. Everything in here is a fact
 * about the file, not the moment it was imported, so the same file dropped
 * twice produces byte-identical content and is recorded `unchanged`.
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
          // The original, byte for byte, so any later reader can redo the parse.
          csvBase64: base64Encode(bytes),
          rows: parse.rows,
        },
      },
    ],
    providerRows: parse.rows.length,
    // Nothing paginates here: the file is whatever Bing's UI wrote, and a cap
    // on the export would be invisible to this lane.
    providerTruncated: false,
  };
}
