// GET  /api/config-documents        — what the store holds (add ?bodies=1 for the documents)
// POST /api/config-documents/seed   — load documents the store does not have yet
// POST /api/config-documents/apply  — apply one changeset to the stored documents
//
// Operator-authed, all three. The callers are `pnpm config:seed`,
// `pnpm config:export` and the Tower's local write lane — every one of them a
// process on the operator's own machine reaching the store through the
// loopback-only ingest door (scripts/ingest-door.mjs). None of them opens the
// store itself; these routes are how a script asks the runtime that already
// holds it (bead ro-mad), so no script needs the store's credential.
//
// The DEPLOYED path does not come through here at all: the Tower calls
// `applyConfigOps` over its private INGEST Service Binding, where the binding
// itself is the capability and no bearer exists to borrow.

import { authenticateOperator } from '../auth.js';
import {
  CONFIG_DOCUMENT_FILES,
  applyConfigOps,
  getConfigDocuments,
  seedConfigDocuments,
} from '../config-store.js';
import { json } from '../responses.js';

/** Every path this module answers, so index.ts can test one prefix. */
export const CONFIG_DOCUMENTS_PREFIX = '/api/config-documents';

export async function handleConfigDocuments(
  request: Request,
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === CONFIG_DOCUMENTS_PREFIX) {
    // `ready` stays in the answer its readers parse (`pnpm config:seed`,
    // `pnpm config:export`): on Postgres the store is always built whole, so a
    // store that answers is ready, and one that fails answers 500.
    const wantBodies = url.searchParams.get('bodies') === '1';
    const reads = await getConfigDocuments(env, CONFIG_DOCUMENT_FILES);
    return json(
      {
        ready: true,
        reason: null,
        known: CONFIG_DOCUMENT_FILES,
        documents: reads
          .filter((read) => read.source === 'store')
          .map((read) => ({
            file: read.file,
            version: read.version,
            updatedAt: read.updatedAt,
            updatedBy: read.updatedBy,
            ...(wantBodies ? { body: read.body } : {}),
          })),
        unseeded: reads.filter((read) => read.source !== 'store').map((read) => read.file),
      },
      200,
    );
  }

  if (request.method === 'POST' && url.pathname === `${CONFIG_DOCUMENTS_PREFIX}/seed`) {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch (err) {
      return json({ error: 'bad_request', detail: `could not parse body: ${String(err)}` }, 400);
    }
    const result = await seedConfigDocuments(
      env,
      parsed as Parameters<typeof seedConfigDocuments>[1],
      nowMs,
    );
    return json(result, result.error === 'store_unavailable' ? 503 : result.ok ? 200 : 422);
  }

  if (request.method === 'POST' && url.pathname === `${CONFIG_DOCUMENTS_PREFIX}/apply`) {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch (err) {
      return json({ error: 'bad_request', detail: `could not parse body: ${String(err)}` }, 400);
    }
    const result = await applyConfigOps(
      env,
      parsed as Parameters<typeof applyConfigOps>[1],
      nowMs,
    );
    if (result.ok) return json(result, 200);
    return json(result, configWriteStatus(result.error));
  }

  return json({ error: 'not_found' }, 404);
}

/** One refusal, one status — shared with the Tower's own `/api/config` so a
 * browser and a script hear the same code for the same fact. */
export function configWriteStatus(error: string): number {
  switch (error) {
    case 'store_unavailable':
    case 'not_seeded':
      return 503;
    case 'expect_mismatch':
    case 'version_mismatch':
      return 409;
    default:
      return 422;
  }
}
