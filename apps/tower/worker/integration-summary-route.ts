/** The two integration status reads. These dependencies cannot call providers
 * or mutate credentials; server composition supplies already admitted readers. */
import type { WorkspaceStore } from '@noticeos/postgres';
import type { CredentialStoreState } from '@noticeos/contract';
import type { TowerConfig } from './config-source';
import { handleIntegrationProvidersRequest } from './integrations-route';
import { handleIntegrationHealthRequest } from './connection-status-daily';
import { loadProviderMeter } from './metered-spend';

export async function handleIntegrationSummaryRead(request: Request, {
  store, config, ingest, now,
}: {
  store: WorkspaceStore;
  config: () => Promise<TowerConfig>;
  ingest: { listCredentialSummaries(): Promise<CredentialStoreState>; integrationHealth(): Promise<unknown> };
  now: Date;
}): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  const pathname = new URL(request.url).pathname;
  if (pathname === '/api/integrations/health') {
    return handleIntegrationHealthRequest(request, ingest, store, now);
  }
  if (pathname === '/api/integrations/providers') {
    const cfg = await config();
    return handleIntegrationProvidersRequest(request, ingest, cfg.integrations, now,
      (meter, at) => loadProviderMeter(store, meter, at, cfg.monthlyCaps.dataUsd));
  }
  return null;
}
