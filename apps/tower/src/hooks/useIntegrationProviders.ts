import { useTowerApi } from '@/lib/browser-context';
import { workspaceReadDenied } from '@/lib/api';
import { AppReleaseError } from '@/lib/app-release';
import { useQuery } from "@tanstack/react-query";
import type { IntegrationCredentialsPayload } from "@shared/integrations-page";


/** The query key every write on the Integrations page invalidates. Exported so
 * a card's Connect / Disconnect and the page's own read cannot drift apart. */
export const INTEGRATION_PROVIDERS_KEY = ["integration-providers"] as const;

/**
 * The provider credential read behind `/integrations`.
 *
 * Slower than the 60s desk cadence on purpose. This payload is operator-entered
 * configuration, not a signal: it changes when somebody presses Save on this
 * page, and every one of those writes invalidates the key itself. What a poll
 * would add is the `lastUsedAt` / `lastOkAt` / `lastError` fields a collector
 * run moves — worth catching, but on the scale of collector runs rather than of
 * a television refresh, and re-reading a credential inventory every minute is
 * spend for nothing.
 */
export function useIntegrationProviders(watch = true) {
  const { fetchIntegrationProviders } = useTowerApi();
  const query = useQuery<IntegrationCredentialsPayload>({
    queryKey: INTEGRATION_PROVIDERS_KEY,
    queryFn: ({ signal }) => fetchIntegrationProviders(signal),
    refetchInterval: watch ? 300_000 : false,
    refetchOnWindowFocus: !watch,
    staleTime: 60_000,
    ...(watch ? {} : { retry: (count: number, error: Error) => !(error instanceof AppReleaseError) && !workspaceReadDenied(error) && count < 1 }),
  });
  return !watch && workspaceReadDenied(query.error) ? { ...query, data: undefined } : query;
}
