// POST /api/insight-snapshot — the executive-snapshot writer (db/0008).
//
// Operator-authed, same shape as /api/beads-snapshot: bearer → hand the
// untrusted body to the writer, which validates every field before touching D1.
// The caller is `scripts/signal-insights-publish.mjs`, run beside a live
// `os:up`; this route is how a reviewed local analysis crosses into the central
// store WITHOUT a second workerd opening the sqlite file (../insight-snapshots.ts
// has the why, bead ro-2zk.3).
//
// The body is read as TEXT, not parsed here, because the row is content-
// addressed over the exact bytes stored. Re-serializing a parsed object would
// change the digest and with it the id, and "publish the same file twice, get
// the same row" is the property that makes this lane safe to re-run.

import { authenticateOperator } from '../auth.js';
import { writeInsightSnapshot } from '../insight-snapshots.js';
import { json } from '../responses.js';

export async function handleInsightSnapshot(
  request: Request,
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }

  const result = await writeInsightSnapshot(env, await request.text(), nowMs);

  if (!result.ok) {
    if (result.error === 'bad_request') {
      return json({ error: 'bad_request', detail: result.detail }, 400);
    }
    if (result.error === 'unknown_asset') {
      return json({ error: 'unknown_asset', detail: result.asset }, 422);
    }
    return json({ error: 'validation', issues: result.issues }, 422);
  }

  // A re-publish is a 200, not a 201: nothing was created, and the publisher
  // says "already published" rather than claiming a write it did not make.
  return json(
    {
      created: result.created,
      duplicate: !result.created,
      id: result.id,
      asset: result.asset,
      contentSha256: result.contentSha256,
      generatedAt: result.generatedAt,
    },
    result.created ? 201 : 200,
  );
}
