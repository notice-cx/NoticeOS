// POST /api/credentials/rotate-key — re-seal every stored credential under a
// new `CREDENTIALS_KEY` (bead `ro-vu8d.11`, epic `ro-vu8d`, table db/0028).
//
// WHY A ROUTE AND NOT A NODE SCRIPT. `db/0028` shipped the `key_version` column
// with nothing able to move a row between generations, so rotating the
// bootstrap secret meant every credential became undecryptable. The obvious fix
// — a script beside `dev-secrets.mjs` reading the same sqlite file — would have
// to DECRYPT IN NODE, and this store's one rule is that plaintext exists inside
// this Worker and nowhere else. So the sweep runs here and `pnpm creds:rotate-key`
// is a client that sends a POST and prints counts.
//
// WHO CAN REACH IT. Two independent things, neither sufficient alone:
//
//   1. the operator bearer token, exactly like the revenue and snapshot lanes;
//   2. the ingest has no listener of its own locally — it is an auxiliary Worker
//      inside the Tower's runtime — so the only path to this handler is the
//      Tower's loopback-bound ingest door (`apps/tower/vite/runner-door.ts`),
//      which the kernel keeps off the LAN. A deployed Worker is reachable only
//      through the Service Binding the Tower holds.
//
// WHAT IT ANSWERS. Counts, the version rows landed on, and provider IDS for the
// rows it could not do — never a field name, never a value, never anything
// derived from either key. A provider id is in the shipped catalog.

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
