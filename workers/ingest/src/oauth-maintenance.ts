import { retireExpiredGoogleOAuth } from '@noticeos/postgres/integration-oauth-custody';
import { PRODUCT_ENV, workspaceProfile } from '../../../scripts/product-env.mjs';
import type { IdentityOptions } from '@noticeos/postgres/identity';

/** Platform-only cron, deliberately absent from standalone default triggers.
 * Remote registration is an explicit operator deployment step. */
export const GOOGLE_OAUTH_MAINTENANCE_CRON = '7 * * * *';

/** Called only by the non-RPC scheduled handler. No operational store, caller
 * selection or tenant action is involved; standalone/demo read no credentials. */
export async function runOAuthMaintenance(env: object): Promise<void> {
  if (workspaceProfile(env) !== 'hosted') return;
  const read = (key: 'identityDatabase' | 'workspaceOrigin' | 'identitySecret'): string => {
    const value = (env as Record<string, unknown>)[PRODUCT_ENV[key].name];
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
      throw new Error('Integration OAuth maintenance is unavailable');
    }
    return value;
  };
  const options: IdentityOptions = { connectionString: read('identityDatabase'),
    trustedOrigin: read('workspaceOrigin'), sessionSecret: read('identitySecret') };
  await retireExpiredGoogleOAuth(options);
}
