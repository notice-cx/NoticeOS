import { readBoundedJsonText } from '../../../../scripts/bounded-json-body.mjs';
import { workspaceProfile } from '../../../../scripts/product-env.mjs';
import { authenticateOperator } from '../auth.js';
import { archivePreparation, legacyArchivePlan, LegacyArchiveRefusal, prepareLegacyArchives } from '../legacy-archive.js';
import { signalObjectScope } from '../signal-objects.js';

export async function handleLegacyArchives(request: Request, env: IngestEnv): Promise<Response> {
  if (workspaceProfile(env) !== 'standalone' || request.headers.has('origin')
    || !env.OPERATOR_TOKEN || !await authenticateOperator(request, env.OPERATOR_TOKEN)) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  if (new URL(request.url).search) return Response.json({ error: 'invalid_request' }, { status: 400 });
  if (request.method !== 'GET' && request.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { allow: 'GET, POST' } });
  }
  try {
    const scope = await signalObjectScope(env);
    if (request.method === 'GET') return Response.json(await legacyArchivePlan(env, scope));
    let body: unknown;
    try { body = JSON.parse(await readBoundedJsonText(request, 1024)); }
    catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
    const expected = archivePreparation(body, scope.workspaceId);
    if (!expected) return Response.json({ error: 'wrong_workspace_or_inventory' }, { status: 400 });
    return Response.json(await prepareLegacyArchives(env, scope, expected));
  } catch (error) {
    if (error instanceof LegacyArchiveRefusal) return Response.json({ error: error.message }, { status: 409 });
    return Response.json({ error: 'archive_access_failed' }, { status: 503 });
  }
}
