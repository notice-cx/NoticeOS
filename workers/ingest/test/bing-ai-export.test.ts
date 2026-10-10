import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BING_AI_EXPORT_MAX_BYTES } from '../src/bing-ai-exports.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { ARCHIVE_RUNS, call, pgAll, pgCount, pgFirst, reset } from './helpers.js';

beforeEach(reset);

/** The UTF-8 BOM every one of these exports opens with, spelled by code point
 * so nobody has to trust an invisible character in this file. */
const BOM = String.fromCharCode(0xfeff);

/** A file exactly as Bing writes it: BOM, CRLF, every field quoted. */
function exportFile(lines: string[]): Uint8Array {
  return new TextEncoder().encode(`${BOM}${lines.join('\r\n')}\r\n`);
}

const QUERIES = exportFile([
  '"Grounding Query","Intent","Topic","Citations","Citation Share"',
  '"how much protein should i eat daily","Learn and Solve","Protein & Muscle Building Nutrition","42488","27.24%"',
  '"my plate food guide","Learn and Solve","Health","4299","44.06%"',
]);

const OVERVIEW = exportFile([
  '"Date","Citations","Cited Pages"',
  '"5/4/2026 12:00:00 AM","326","11"',
  '"6/15/2026 12:00:00 AM","8123","41"',
]);

const PAGES = exportFile([
  '"Page","Citations"',
  '"https://meals.example/protein-calculator","294996"',
]);

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

interface ImportBody {
  imported?: boolean;
  asset?: string;
  report?: string;
  exportName?: string;
  exportDate?: string;
  status?: string;
  rows?: number;
  objectKey?: string;
  fileSha256?: string;
  fileBytes?: number;
  error?: string;
  detail?: string;
  issues?: { path: string; code: string; message: string }[];
}

async function importExport(
  overrides: Record<string, unknown> = {},
  token: string | null = OPERATOR_TOKEN,
): Promise<{ status: number; body: ImportBody }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await call(
    new Request('https://ingest.local/api/bing-ai-export', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        asset: 'meals.example',
        file: 'meals.example_AISearchQueriesReport_8_4_2026.csv',
        exportDate: '2026-08-04',
        contentBase64: base64(QUERIES),
        ...overrides,
      }),
    }),
  );
  return { status: res.status, body: (await res.json()) as ImportBody };
}

async function archiveJson(objectKey: string): Promise<Record<string, any>> {
  const object = await env.RAW_SIGNALS.get(objectKey);
  expect(object).not.toBeNull();
  const text = await new Response(
    object!.body.pipeThrough(new DecompressionStream('gzip')),
  ).text();
  return JSON.parse(text);
}

describe('POST /api/bing-ai-export — the door', () => {
  it('rejects an unauthenticated import (401) and stores nothing', async () => {
    const { status, body } = await importExport({}, null);
    expect(status).toBe(401);
    expect(body.error).toBe('unauthorized');
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS}`)).toBe(0);
  });

  it('rejects a wrong operator token (401)', async () => {
    expect((await importExport({}, 'nope')).status).toBe(401);
  });

  it('refuses a body that is not a JSON object (400)', async () => {
    const res = await call(
      new Request('https://ingest.local/api/bing-ai-export', {
        method: 'POST',
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('refuses a property the store does not know (422)', async () => {
    const { status, body } = await importExport({ asset: 'not-a-property.test' });
    expect(status).toBe(422);
    expect(body.error).toBe('unknown_asset');
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS}`)).toBe(0);
  });

  it('refuses an export date in the future', async () => {
    const ahead = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const { status, body } = await importExport({ exportDate: ahead });
    expect(status).toBe(422);
    expect((body.issues ?? []).map((issue) => issue.path)).toContain('exportDate');
  });

  it('refuses a file larger than the lane accepts', async () => {
    const huge = new Uint8Array(BING_AI_EXPORT_MAX_BYTES + 1);
    huge.fill(0x41);
    const { status, body } = await importExport({ contentBase64: base64(huge) });
    expect(status).toBe(400);
    expect(body.detail).toMatch(/bytes; this lane accepts at most/);
  });
});

// A parser that maps columns by position is how a silent corruption starts.
describe('POST /api/bing-ai-export — what it refuses to guess', () => {
  it('refuses an unrecognized header and names the three it knows (422)', async () => {
    const { status, body } = await importExport({
      contentBase64: base64(
        exportFile(['"Query","Clicks","Impressions"', '"protein","4","90"']),
      ),
    });
    expect(status).toBe(422);
    expect(body.error).toBe('bing_ai_export_unknown_format');
    expect(body.detail).toMatch(/AIPerformanceOverviewStats/);
    expect(body.detail).toMatch(/AISearchQueriesReport/);
    expect(body.detail).toMatch(/AIPageStatsReport/);
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS}`)).toBe(0);
  });

  it('refuses a header that merely gained a column', async () => {
    const { status, body } = await importExport({
      contentBase64: base64(
        exportFile([
          '"Grounding Query","Intent","Topic","Citations","Citation Share","Surface"',
          '"protein","Learn and Solve","Health","42488","27.24%","Copilot"',
        ]),
      ),
    });
    expect(status).toBe(422);
    expect(body.error).toBe('bing_ai_export_unknown_format');
  });

  // `Number.parseInt('1,234')` is 1. A count read that way understates by 200x
  // and nothing anywhere would say so.
  it('refuses a count that is not digits', async () => {
    const { status, body } = await importExport({
      contentBase64: base64(
        exportFile([
          '"Page","Citations"',
          '"https://meals.example/protein-calculator","294,996"',
        ]),
      ),
      file: 'meals.example_AIPageStatsReport_8_4_2026.csv',
    });
    expect(status).toBe(422);
    expect(body.error).toBe('bing_ai_export_bad_count');
    expect(body.detail).toMatch(/294,996/);
  });

  it('refuses a date that is not the pinned M/D/YYYY midnight spelling', async () => {
    const { status, body } = await importExport({
      contentBase64: base64(
        exportFile(['"Date","Citations","Cited Pages"', '"2026-05-04","326","11"']),
      ),
      file: 'meals.example_AIPerformanceOverviewStats_8_4_2026.csv',
    });
    expect(status).toBe(422);
    expect(body.error).toBe('bing_ai_export_bad_date');
  });

  // The export date is read off the filename, so a filename that disagrees with
  // the header would date the wrong report.
  it('refuses a filename that names a different export than the header (422)', async () => {
    const { status, body } = await importExport({
      file: 'meals.example_AIPageStatsReport_8_4_2026.csv',
    });
    expect(status).toBe(422);
    expect(body.error).toBe('bing_ai_export_filename_mismatch');
  });

  it('refuses bytes that are not UTF-8', async () => {
    const { status, body } = await importExport({
      contentBase64: base64(new Uint8Array([0xff, 0xfe, 0x22, 0x50])),
    });
    expect(status).toBe(422);
    expect(body.error).toBe('bing_ai_export_not_utf8');
  });
});

describe('POST /api/bing-ai-export — what it stores', () => {
  it('archives the original bytes and the parse, keyed on the export date', async () => {
    const { status, body } = await importExport();
    expect(status).toBe(201);
    expect(body).toMatchObject({
      imported: true,
      asset: 'meals.example',
      report: 'ai-queries',
      exportName: 'AISearchQueriesReport',
      exportDate: '2026-08-04',
      status: 'success',
      rows: 2,
    });

    const row = await pgFirst<Record<string, unknown>>(`SELECT asset, integration, report, report_date, data_state, status,
              provider_rows, request_count, provider_truncated, credential_ref,
              property_ref, object_key
         FROM ${ARCHIVE_RUNS}`);
    expect(row).toMatchObject({
      asset: 'meals.example',
      // These rows ARE Bing Webmaster Tools; the report name is what tells the
      // AI families apart from the API ones.
      integration: 'bing-webmaster',
      report: 'ai-queries',
      report_date: '2026-08-04',
      data_state: 'provider-snapshot',
      status: 'success',
      provider_rows: 2,
      request_count: 1,
      provider_truncated: 0,
      // No credential crossed this lane: a human clicked Export.
      credential_ref: 'operator-export',
    });

    const archive = await archiveJson(body.objectKey!);
    expect(archive.integration).toBe('bing-webmaster');
    expect(archive.report).toBe('ai-queries');
    expect(archive.reportDate).toBe('2026-08-04');
    // The original, byte for byte — the parse can always be redone.
    expect(archive.pages[0].response.csvBase64).toBe(base64(QUERIES));
    expect(archive.pages[0].request.file).toBe(
      'meals.example_AISearchQueriesReport_8_4_2026.csv',
    );
    expect(archive.pages[0].request.header).toEqual([
      'Grounding Query',
      'Intent',
      'Topic',
      'Citations',
      'Citation Share',
    ]);
    expect(archive.pages[0].response.rows[0]).toEqual({
      query: 'how much protein should i eat daily',
      intent: 'Learn and Solve',
      topic: 'Protein & Muscle Building Nutrition',
      citations: 42488,
      // Percentage points, not a fraction.
      citationSharePercent: 27.24,
    });
  });

  it('reads the daily overview series and the page report too', async () => {
    const overview = await importExport({
      file: 'meals.example_AIPerformanceOverviewStats_8_4_2026.csv',
      contentBase64: base64(OVERVIEW),
    });
    expect(overview.status).toBe(201);
    expect(overview.body.report).toBe('ai-overview');
    expect(overview.body.rows).toBe(2);
    const overviewArchive = await archiveJson(overview.body.objectKey!);
    expect(overviewArchive.pages[0].response.rows).toEqual([
      { date: '2026-05-04', citations: 326, citedPages: 11 },
      { date: '2026-06-15', citations: 8123, citedPages: 41 },
    ]);

    const pages = await importExport({
      file: 'meals.example_AIPageStatsReport_8_4_2026.csv',
      contentBase64: base64(PAGES),
    });
    expect(pages.status).toBe(201);
    expect(pages.body.report).toBe('ai-pages');
    const pagesArchive = await archiveJson(pages.body.objectKey!);
    expect(pagesArchive.pages[0].response.rows).toEqual([
      { page: 'https://meals.example/protein-calculator', citations: 294996 },
    ]);
  });

  // "Did that land?" must be answerable by running it again.
  it('records a re-import of the same file as unchanged, with no second copy', async () => {
    const first = await importExport();
    expect(first.status).toBe(201);
    const again = await importExport();
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('unchanged');
    expect(again.body.objectKey).toBe(first.body.objectKey);

    // Two attempts on the manifest — the second one proves the import ran — and
    // exactly one object in the bucket.
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS}`)).toBe(2);
    expect((await env.RAW_SIGNALS.list()).objects).toHaveLength(1);
  });

  it('lands a later export beside the earlier one as the next dated snapshot', async () => {
    const july = await importExport({
      file: 'meals.example_AISearchQueriesReport_7_12_2026.csv',
      exportDate: '2026-07-12',
      contentBase64: base64(
        exportFile([
          '"Grounding Query","Intent","Topic","Citations","Citation Share"',
          '"how much protein should i eat daily","Learn and Solve","Protein & Muscle Building Nutrition","30129","27.93%"',
        ]),
      ),
    });
    expect(july.status).toBe(201);
    const august = await importExport();
    expect(august.status).toBe(201);

    const rows = await pgAll<{ report_date: string; provider_rows: number }>(`SELECT report_date, provider_rows FROM ${ARCHIVE_RUNS}
        WHERE report = 'ai-queries' ORDER BY report_date`);
    expect(rows.results).toEqual([
      { report_date: '2026-07-12', provider_rows: 1 },
      { report_date: '2026-08-04', provider_rows: 2 },
    ]);
  });

  // An export with no rows is a real observation — a property Bing's assistants
  // did not cite — and must archive rather than error.
  it('archives an export that carries only a header', async () => {
    const { status, body } = await importExport({
      contentBase64: base64(
        exportFile(['"Grounding Query","Intent","Topic","Citations","Citation Share"']),
      ),
    });
    expect(status).toBe(201);
    expect(body.rows).toBe(0);
  });
});
