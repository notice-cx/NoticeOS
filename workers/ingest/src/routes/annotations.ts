// POST /api/annotations — the timeline-event writer. Operator-authed, same
// shape as /api/revenue. Backdating is allowed and expected: a batch that
// shipped three weeks ago is annotated at its ship time. One of two lanes onto
// the same writer (../annotations.ts); the other is the `createAnnotation()`
// RPC the Tower reaches over its Service Binding.

import type { CreateAnnotationInput } from '@noticeos/contract';
import { writeAnnotation } from '../annotations.js';
import { authenticateOperator } from '../auth.js';
import { json } from '../responses.js';
import { readJsonObject } from './validate.js';

export async function handleAnnotations(
  request: Request,
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  // A claim, not a check: `writeAnnotation` validates every field of it.
  const result = await writeAnnotation(env, body as unknown as CreateAnnotationInput, nowMs);

  if (!result.ok) {
    if (result.error === 'unknown_asset') {
      return json({ error: 'unknown_asset', detail: result.asset }, 422);
    }
    return json({ error: 'validation', issues: result.issues }, 422);
  }
  if (result.created) {
    return json({ created: true, duplicate: false, annotation: result.annotation }, 201);
  }
  return json({ created: false, duplicate: true, annotation: result.annotation }, 200);
}
