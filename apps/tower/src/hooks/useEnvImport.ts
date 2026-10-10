import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from "@tanstack/react-query";
import type { EnvImportAvailability } from "@shared/env-import";


/**
 * Unknown until the answer arrives, the opposite default from
 * `useConfigWritable`: an Import button drawn on a deployed build and pressed
 * would 501, so the card shows neither affordance until it knows, and a
 * failed question reads as "not from here", with the command.
 */
const UNKNOWN: EnvImportAvailability = { importable: false, reason: null };

/**
 * Can the legacy env credentials be imported from this deployment? Asked once
 * per session (`staleTime: Infinity`, no retry): it is a fact about the build
 * the browser loaded and the machine serving it.
 */
export function useEnvImportAvailability(enabled = true): EnvImportAvailability {
  const { fetchEnvImportAvailability } = useTowerApi();
  const { data } = useQuery<EnvImportAvailability>({
    queryKey: ["env-import-available"],
    queryFn: ({ signal }) => fetchEnvImportAvailability(signal),
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  return enabled ? data ?? UNKNOWN : UNKNOWN;
}
