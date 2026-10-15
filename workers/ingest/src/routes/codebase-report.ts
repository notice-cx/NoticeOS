// POST /api/codebase-report: a site's codebase measurement arrives.
//
// Authenticated as the nightly report is: the asset id in the body selects the
// token, so the body is parsed and the caller identified before the envelope
// is validated, and a 422 with issues goes only to an authenticated caller. A
// body over the contract's size limit is refused before it is parsed.

import { CODEBASE_REPORT_MAX_BYTES } from '@noticeos/contract';
import { authenticateAsset } from '../auth.js';
import { ingestCodebaseReport, type CodebaseReportWritten } from '../codebase.js';
import { json, zodIssues } from '../responses.js';

const tooLarge = () =>
  json({ error: 'payload_too_large', detail: `body is larger than ${CODEBASE_REPORT_MAX_BYTES} bytes` }, 413);

export async function handleCodebaseReport(request: Request, env: IngestEnv): Promise<Response> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > CODEBASE_REPORT_MAX_BYTES) return tooLarge();
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > CODEBASE_REPORT_MAX_BYTES) return tooLarge();

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json({ error: 'bad_request', detail: 'body is not valid JSON' }, 400);
  }

  const assetId = (body as { asset?: unknown } | null)?.asset;
  if (typeof assetId !== 'string' || assetId.length === 0) {
    return json({ error: 'unauthorized', detail: 'asset id missing from body' }, 401);
  }
  if (!(await authenticateAsset(request, env.ASSET_TOKENS, assetId))) {
    return json({ error: 'unauthorized' }, 401);
  }

  const outcome = await ingestCodebaseReport(env, body);
  if (!outcome.ok) {
    return json({ error: 'unprocessable_entity', issues: zodIssues(outcome.error) }, 422);
  }
  const { reportNumber, reportDate, revision } = outcome.result;
  const written: CodebaseReportWritten = { reportNumber, reportDate, revision };
  return json({ ok: true, ...written }, 201);
}
