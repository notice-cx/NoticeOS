import type { CredentialStoreState } from '@noticeos/contract';
import { listCredentialSummaries } from './credentials.js';
import { withCredentialPropertyMaps } from './google-signals.js';

/**
 * The whole body of the `listCredentialSummaries()` RPC: every provider's
 * connection state, field names, timestamps and the last verdict, and never a
 * value. Its own module so the isolated journey harness serves the
 * Integrations cards from this same read over its fixture rows.
 */
export async function readCredentialSummaries(env: IngestEnv): Promise<CredentialStoreState> {
  // Whether the Google credential's own property map is still anyone's only
  // answer: only this Worker can read the blob, so only this Worker can ask
  // the question of the assets the credential names.
  const state = await listCredentialSummaries(env);
  return withCredentialPropertyMaps(env, state);
}
