import { CODEBASE_IMPORT_MAX_BYTES, CodebaseHistoryImport } from '@noticeos/contract';
import { readBoundedJsonText } from '../../../../scripts/bounded-json-body.mjs';
import { authenticateAsset } from '../auth.js';
import { assetKnown } from '../asset-registry.js';
import { importCodebaseHistory } from '../codebase-history.js';
import { json, zodIssues } from '../responses.js';

export async function handleCodebaseHistory(request: Request, env: IngestEnv): Promise<Response> {
  let body: unknown;
  try { body = JSON.parse(await readBoundedJsonText(request, CODEBASE_IMPORT_MAX_BYTES)); }
  catch { return json({ error: 'invalid_or_oversized_history' }, 400); }
  const asset = (body as { asset?: unknown } | null)?.asset;
  if (typeof asset !== 'string' || !(await authenticateAsset(request, env.ASSET_TOKENS, asset))) return json({ error: 'unauthorized' }, 401);
  const parsed = CodebaseHistoryImport.safeParse(body);
  if (!parsed.success) return json({ error: 'unprocessable_entity', issues: zodIssues(parsed.error) }, 422);
  if (!(await assetKnown(env.STORE, asset))) return json({ error: 'unknown_asset' }, 422);
  const preview = new URL(request.url).searchParams.get('apply') !== 'true';
  try { return json({ ok: true, ...await importCodebaseHistory(env.STORE, parsed.data, preview) }, preview ? 200 : 201); }
  catch (error) {
    if (error instanceof Error && /^(history contains|send a current report)/u.test(error.message)) return json({ error: 'invalid_history', detail: error.message }, 422);
    throw error;
  }
}
