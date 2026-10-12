// Demo connections: the providers the synthetic demo workspace shows connected
// with no login. No secret or key exists and nothing is fetched. Only the
// server's demo profile holds one, and only for the one demo workspace its
// composition names; any other profile or workspace, whatever its rows say,
// reads these providers as not connected, and a credential the workspace
// stores is always the answer. Their evidence is the collection runs the
// demo's simulator records.

import type { IntegrationProviderId } from '@noticeos/contract';
import { readProductEnv, workspaceProfile } from '../../../scripts/product-env.mjs';

/** The providers whose counts the demo's simulator records: Google's
 * Analytics and Search Console, Bing, and the ad network. */
export const DEMO_CONNECTED_PROVIDERS: readonly IntegrationProviderId[] = Object.freeze(['google', 'bing-webmaster', 'mediavine']);

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

/** Whether this call's store is the demo profile's own demo workspace. */
export async function isDemoWorkspace(env: IngestEnv): Promise<boolean> {
  try {
    if (workspaceProfile(env) !== 'demo' || !env.STORE) return false;
    const demo = readProductEnv(env as unknown as Readonly<Record<string, string | undefined>>, 'demoWorkspace');
    return demo !== undefined && UUID.test(demo) && (await env.STORE.workspaceId()) === demo;
  } catch {
    return false;
  }
}

/** Whether `provider` is one of the demo workspace's demo connections. */
export async function demoConnection(env: IngestEnv, provider: string): Promise<boolean> {
  return (DEMO_CONNECTED_PROVIDERS as readonly string[]).includes(provider) && await isDemoWorkspace(env);
}
