import { useTowerApi } from '@/lib/browser-context';
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { SettingsPayload } from "@shared/settings";


/**
 * The settings page's one read. Polled rather than fetched once: a file save
 * restarts the local Worker, `useConfigSave` invalidates the `settings` key
 * once that restart has landed, and the poll is the backstop for a config
 * change made outside the browser. `keepPreviousData` so a poll that lands
 * mid-restart shows the last good payload instead of blanking a page the
 * operator is typing into.
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
