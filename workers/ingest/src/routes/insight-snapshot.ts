// POST /api/insight-snapshot — the executive-snapshot writer. Operator-authed;
// the body is handed to the writer, which validates every field. The body is
// read as text, not parsed here, because the row is content-addressed over the
// exact bytes stored: re-serializing would change the digest and the id.

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
