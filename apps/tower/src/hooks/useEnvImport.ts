import { useTowerApi } from '@/lib/browser-context';
import { useQuery } from "@tanstack/react-query";
import type { EnvImportAvailability } from "@shared/env-import";


/**
 * Unknown until the answer arrives — the OPPOSITE default from
 * `useConfigWritable`, and deliberately so.
 *
 * That hook assumes writable because a field that renders disabled for a beat on
 * every page load is the worse lie: the refusal it would otherwise meet carries
 * the same sentence anyway. Here the optimistic guess has no such safety net —
 * an Import button drawn on a deployed build and pressed would 501, which is the
 * exact "a button that 404s teaches the operator not to trust the page" this
 * bead exists to prevent. So the card shows neither affordance until it knows,
 * and a failed question reads as "not from here", with the command.
 */
const UNKNOWN: EnvImportAvailability = { importable: false, reason: null };

/**
 * Can the legacy env credentials be imported from THIS deployment (bead
 * `ro-vu8d.7`)?
 *
 * Asked ONCE per session (`staleTime: Infinity`, no retry): it is a fact about
 * the build the browser loaded and the machine serving it, and it cannot change
 * under a running page.
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
