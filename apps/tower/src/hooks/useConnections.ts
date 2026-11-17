import type { CredentialSummary } from '@noticeos/contract/integrations';
import { useIntegrationHealth } from './useIntegrationHealth';
import { useIntegrationProviders } from './useIntegrationProviders';

/**
 * The two reads every connection status is derived from: the stored
 * credentials and the monitoring items. A read
 * that has not answered is `undefined` / `null`, which the model turns into
 * Unknown — never into Not connected.
 */
export function useConnections(watch = true) {
  const providers = useIntegrationProviders(watch);
  const monitoring = useIntegrationHealth(watch);
  const credentials: ReadonlyMap<string, CredentialSummary> | undefined = providers.data
    ? new Map((providers.data.providers ?? []).map((status) => [status.provider.id, status.credential]))
    : undefined;
  return { providers, monitoring, credentials, events: monitoring.data?.events, snapshot: monitoring.snapshot,
    items: monitoring.data ? monitoring.status.items : null };
}
