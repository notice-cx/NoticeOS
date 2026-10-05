import { useTowerApi } from '@/lib/browser-context';
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { SettingsPayload } from "@shared/settings";


/**
 * The settings page's one read (bead `ro-pbzu.2`).
 *
 * Polled like every other desk surface rather than fetched once, for one
 * reason: a Save through the write lane commits a file and RESTARTS the local
 * Worker, so the value the page must show next comes from a rebuilt bundle.
 * `useConfigSave` invalidates the `settings` key once that restart has had time
 * to land; the poll is the backstop for a config change made outside the
 * browser — an edit in the editor, a `pnpm config:apply`, a pulled commit.
 *
 * `keepPreviousData` so a poll that lands mid-restart shows the last good
 * payload instead of blanking a page the operator is typing into.
 */
export function useSettings() {
  const { fetchSettings } = useTowerApi();
  return useQuery<SettingsPayload>({
    queryKey: ["settings"],
    queryFn: ({ signal }) => fetchSettings(signal),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}
