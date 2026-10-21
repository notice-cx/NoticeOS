import { useTowerApi } from '@/lib/browser-context';
import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { SettingsPayload, SettingsPreferences } from "@shared/settings";

/** Settings editors read the complete payload; rate and clock readers ask for
 * preferences. Both shapes share config-save invalidation and polling rules. */
export function useSettings(view: 'preferences'): UseQueryResult<SettingsPreferences>;
export function useSettings(): UseQueryResult<SettingsPayload>;
export function useSettings(view?: 'preferences') {
  const { fetchSettings, fetchSettingsPreferences } = useTowerApi();
  return useQuery<SettingsPayload | SettingsPreferences>({
    queryKey: view ? ["settings", view] : ["settings"],
    queryFn: ({ signal }) => view ? fetchSettingsPreferences(signal) : fetchSettings(signal),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}
