import type { CredentialStoreState } from '@noticeos/contract';
import { listCredentialSummaries } from './credentials.js';
import { withCredentialPropertyMaps } from './google-signals.js';

/**
 * The whole body of the `listCredentialSummaries()` RPC: every provider's
 * connection state — field NAMES, timestamps and the last verdict, and NEVER a
 * value (bead `ro-vu8d.1`). The Tower's `/api/integrations/providers` route is
 * its one caller.
 *
 * Its own module, like `readIntegrationHealth`, so the isolated journey harness
 * serves the Integrations credential cards from this same read over the rows
 * its fixture store holds, rather than from a second, hand-written answer that
 * could drift from what an install actually shows (bead `ro-ujb9.90`).
 */
export async function readCredentialSummaries(env: IngestEnv): Promise<CredentialStoreState> {
  // One extra fact rides along, and it is the ingest's to give (bead
  // `ro-vu8d.22`): whether the Google credential's own property map is still
  // anyone's only answer. Only this Worker can read the blob, so only this
  // Worker can ask the question of the assets the CREDENTIAL names — which is
  // the question the collector asks. The Tower used to derive a second answer
  // from `config/integrations.json` alone, and the two disagreed about an
  // asset the credential names that the register has no entry for.
  const state = await listCredentialSummaries(env);
  return withCredentialPropertyMaps(env, state);
}
