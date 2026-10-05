// POST /api/annotations — the timeline-event writer (docs/02 §Annotations).
//
// The `annotations` table has had three readers in the Tower (timeline, alert
// correlation, freshness) and, until now, no writer outside the dev-seed
// fixtures: every "did the last change move the signal?" surface was reading an
// empty table. docs/03 opens by naming exactly this gap — v1's attribution was
// "a deploy annotation and a hopeful look at the chart" — so the row this route
// writes is the minimum an honest Attribute stage needs.
//
// Operator-authed, same shape as /api/revenue. Backdating is allowed and
// expected: a batch that shipped three weeks ago is annotated at its ship time,
// not at the time somebody remembered to record it. This route is one of two
// lanes onto the same writer (../annotations.ts); the other is the
// `createAnnotation()` RPC the Tower reaches over its Service Binding. What
// differs between them is only how the caller proves it may write.

import type { CreateAnnotationInput } from '@noticeos/contract';
import { writeAnnotation } from '../annotations.js';
import { authenticateOperator } from '../auth.js';
import { json } from '../responses.js';
import { asObject } from './validate.js';

export async function handleAnnotations(
  request: Request,
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch (err) {
    return json({ error: 'bad_request', detail: `could not parse body: ${String(err)}` }, 400);
  }
  const body = asObject(parsed);
  if (!body) {
    return json({ error: 'bad_request', detail: 'body must be a JSON object' }, 400);
  }

  // A claim, not a check: the body is caller-supplied JSON and `writeAnnotation`
  // validates every field of it before touching D1.
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
