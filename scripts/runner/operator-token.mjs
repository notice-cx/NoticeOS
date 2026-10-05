// runner/operator-token.mjs — the operator bearer the local runner presents at
// its own ingest door. Read from home's secret files (runner/config.mjs
// SECRET_FILES) through scripts/dev-secrets.mjs on every call, and never logged.

import { readDevSecretBindings } from '../dev-secrets.mjs';
import { SECRET_FILES } from './config.mjs';

/** The operator bearer, re-read every tick so rotating the secret does not need
 * an os:up restart (the same posture as the file-backed Tower config). */
export async function operatorToken() {
  const { bindings } = await readDevSecretBindings(SECRET_FILES);
  const token = bindings?.OPERATOR_TOKEN;
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null;
}
