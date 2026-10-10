// POST /api/credentials/rotate-key: re-seal every stored credential under a
// new `CREDENTIALS_KEY`. A route because plaintext exists inside this Worker
// and nowhere else; `pnpm creds:rotate-key` is a client that sends a POST and
// prints counts. Reachable only with the operator bearer and only through the
// Tower's loopback-bound ingest door or its Service Binding. It answers
// counts, the version rows landed on, and provider ids for the rows it could
// not do; never a field name, a value, or anything derived from either key.

import { authenticateOperator } from '../auth.js';
import { rotateCredentialKeys } from '../credentials.js';
import { json } from '../responses.js';

export async function handleRotateCredentialKey(
  request: Request,
  env: IngestEnv,
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  const result = await rotateCredentialKeys(env);
  // A refusal is a 409 rather than a 500: nothing failed, the install is simply
  // not in the two-key window the sweep needs, and `reason` is the sentence
  // that puts it there.
  return json(result, result.ok ? 200 : 409);
}
