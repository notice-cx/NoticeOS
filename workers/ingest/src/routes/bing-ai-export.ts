// POST /api/bing-ai-export: archive one operator-downloaded Bing AI
// Performance export. The file crosses the loopback ingest door as base64 so
// the one runtime that owns the store does the write. The header row decides
// which of the three exports this is, the filename must agree with it because
// the export date is read off the filename, and the property must exist before
// a byte enters R2. The archive is built from the file alone, so the same file
// imported twice is recorded `unchanged`; a later export lands on its own date.

import {
  BING_AI_CREDENTIAL_REF,
  BING_AI_EXPORT_MAX_BYTES,
  BING_AI_INTEGRATION,
  BingAiExportError,
  assertFilenameAgrees,
  bingAiCollectedDump,
  decodeBase64,
  detectBingAiFormat,
  parseBingAiExport,
  type BingAiExportParse,
} from '../bing-ai-exports.js';
import { authenticateOperator } from '../auth.js';
import { json } from '../responses.js';
import { sha256Hex } from '../shared.js';
import { SignalError } from '../signal-store.js';
import {
  archiveCollectedDump,
  type DumpTarget,
  type SignalDumpOutcome,
} from '../signal-dumps.js';
import { Issues, SITE_ROW_FIELDS, declaredString, isoDate, readJsonObject, requiredString } from './validate.js';

/** Base64 is 4 characters per 3 bytes; the slack covers padding and any
 * newlines a caller's encoder inserted. */
const BASE64_MAX_LENGTH = Math.ceil((BING_AI_EXPORT_MAX_BYTES * 4) / 3) + 1024;
const FILE_NAME_MAX = 255;

export async function handleBingAiExport(
  request: Request,
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  const issues = new Issues();
  const asset = declaredString(issues, body.asset, 'asset', SITE_ROW_FIELDS.id);
  const file =requiredString(issues, body.file, 'file', FILE_NAME_MAX);
  const exportDate = isoDate(issues, body.exportDate, 'exportDate');
  if (
    exportDate !== null &&
    Date.parse(`${exportDate}T00:00:00.000Z`) > nowMs + 86_400_000
  ) {
    // A day of slack for the operator's timezone: Bing stamps the filename in
    // local time. Further ahead is a typo, and a future date would sort itself
    // to the top of the dated series forever.
    issues.add('exportDate', 'custom', 'exportDate must not be in the future');
  }
  const contentBase64 = requiredString(issues, body.contentBase64, 'contentBase64', BASE64_MAX_LENGTH);

  if (!issues.ok || asset === null || file === null || exportDate === null || contentBase64 === null) {
    return json({ error: 'validation', issues: issues.list }, 422);
  }

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(contentBase64);
  } catch {
    return json({ error: 'bad_request', detail: 'contentBase64 is not valid base64' }, 400);
  }
  if (bytes.byteLength === 0) {
    return json({ error: 'bad_request', detail: `${file} is empty` }, 400);
  }
  if (bytes.byteLength > BING_AI_EXPORT_MAX_BYTES) {
    return json(
      {
        error: 'bad_request',
        detail:
          `${file} is ${bytes.byteLength} bytes; this lane accepts at most ` +
          `${BING_AI_EXPORT_MAX_BYTES}. A Bing AI Performance export is kilobytes — ` +
          'check that this is the file you meant to drop.',
      },
      400,
    );
  }

  let text: string;
  try {
    // `ignoreBOM: true` keeps the byte-order mark in the string so the one
    // place that decides what to do with a BOM is the parser (bing-ai-exports.ts).
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return json(
      {
        error: 'bing_ai_export_not_utf8',
        detail: `${file} is not UTF-8. Bing exports UTF-8 with a BOM; a re-saved file may not be.`,
      },
      422,
    );
  }

  let parse: BingAiExportParse;
  try {
    parse = parseBingAiExport(text);
    assertFilenameAgrees(file, detectBingAiFormat(parse.header));
  } catch (error) {
    if (error instanceof BingAiExportError) {
      return json({ error: error.code, detail: `${file}: ${error.message}` }, 422);
    }
    throw error;
  }

  // A property the store does not know is a 422 that says so rather than a
  // foreign-key failure.
  const [property] = await env.STORE.read((tx) =>
    tx.query<{ id: string; domain: string | null }>(
      `SELECT asset_id AS id, domain FROM noticeos.assets WHERE asset_id = $1`,
      [asset],
    ),
  );
  if (!property) {
    return json({ error: 'unknown_asset', detail: `${asset} is not a property in the store.` }, 422);
  }

  const target: DumpTarget = {
    asset,
    integration: BING_AI_INTEGRATION,
    // No credential crossed this lane: a human signed into the dashboard and
    // clicked Export. Saying so beats naming a key that was never used.
    credentialRef: BING_AI_CREDENTIAL_REF,
    propertyRef: property.domain ?? asset,
  };
  const fileSha256 = await sha256Hex(bytes);

  let outcome: SignalDumpOutcome;
  try {
    outcome = await archiveCollectedDump(env, {
      provider: 'microsoft',
      target,
      report: parse.report,
      // The export date IS the report date: two of the three exports carry no
      // date column, and all three describe "the report as of the day it was
      // downloaded".
      reportDate: exportDate,
      requestedAt: new Date(nowMs).toISOString(),
      dataState: 'provider-snapshot',
      collected: bingAiCollectedDump({ file, exportDate, bytes, fileSha256, parse }),
    });
  } catch (error) {
    // No failure row is written here: `signal_dump_runs` errors describe a
    // collector that could not reach a provider, and this lane never called Bing.
    if (error instanceof SignalError) {
      return json({ error: error.code, detail: error.message }, 422);
    }
    throw error;
  }

  return json(
    {
      imported: true,
      asset,
      file,
      exportName: parse.exportName,
      report: parse.report,
      grain: parse.grain,
      exportDate,
      // 'unchanged' means this exact file was already archived for this export
      // date — nothing was double-counted, and nothing was lost.
      status: outcome.status,
      rows: outcome.providerRows,
      objectKey: outcome.objectKey,
      fileSha256,
      fileBytes: bytes.byteLength,
    },
    outcome.status === 'success' ? 201 : 200,
  );
}
