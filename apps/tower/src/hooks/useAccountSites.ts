import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from "@tanstack/react-query";


/**
 * What a connected account holds, for a site's own Data sources row.
 *
 * The same read the connect panel's site list makes
 * (`GET /api/integrations/:provider/sites`, one free provider call inside the
 * ingest, nothing stored), so the row picks from exactly what the panel
 * matched — a PostHog project by name and number, its saved funnels — rather
 * than asking for them to be typed. One key per provider: every row on the
 * page that asks shares one answer, and a tab switch inside the `staleTime`
 * asks nothing.
 *
 * A read that fails is not retried: the row falls back to its typed fields.
 */
export function useAccountSites(provider: string, enabled: boolean) {
  const { fetchProviderSites } = useTowerApi();
  return useQuery({
    queryKey: ["account-sites", provider],
    // No abort signal: a read cancelled by StrictMode's rehearsal unmount
    // would be asked again on the remount — the provider asked twice.
    queryFn: () => fetchProviderSites(provider),
    enabled,
    // A project list changes when somebody makes a project in the provider,
    // which is not on this page.
    staleTime: 5 * 60_000,
    retry: 0,
    refetchOnWindowFocus: false,
  });
}
