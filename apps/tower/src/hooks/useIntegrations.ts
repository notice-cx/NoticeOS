import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from "@tanstack/react-query";
import type { IntegrationsMatrix } from "@shared/integrations";


/**
 * Polling read for the portfolio integration matrix (desk-only). Same 60s
 * cadence as the Wall and asset detail, keeping the last-good payload on a
 * failed poll so the matrix never blanks.
 */
export function useIntegrations() {
  const { fetchIntegrations } = useTowerApi();
  return useQuery<IntegrationsMatrix>({
    queryKey: ["integrations"],
    queryFn: ({ signal }) => fetchIntegrations(signal),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
