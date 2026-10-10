import { useDemoReadonly } from '@/lib/browser-context';
import { useTowerApi, useBrowserRuntime } from '@/lib/browser-context';
import { useQuery } from "@tanstack/react-query";
import { type ConfigWritability } from "@/lib/api";
import { DEMO_READ_ONLY } from '@shared/demo-viewer';

/** Assumed until the answer arrives, and if the question fails: a field that
 * flashes disabled on every load is worse than a Save the write path then
 * refuses. `sources` is empty rather than optimistic, so an unknown file reads
 * as the compiled copy and `configSaveDelayMs` waits out a possible restart. */
const OPTIMISTIC: ConfigWritability = { writable: true, reason: null, sources: {} };

/** What a disabled control says when the deployment gave no sentence of its
 * own. Exported so a surface stating it ONCE for a group of editors says the
 * same words the editors would have said each. */
export const CONFIG_READ_ONLY_FALLBACK =
  "Settings cannot be saved right now.";

/** Save availability is runtime state: a store can fail and recover without a
 * page reload. Recheck on focus/mount and while an editor is visible. The write
 * lane still checks every Save; this read only keeps the controls truthful. */
export function useConfigWritable(): ConfigWritability {
  const demoReadonly = useDemoReadonly();
  const demo = useBrowserRuntime().owner.mode === 'demo' || demoReadonly;
  const { fetchConfigWritable } = useTowerApi();
  const { data, isError } = useQuery<ConfigWritability>({
    queryKey: ["config-writable"],
    queryFn: ({ signal }) => fetchConfigWritable(signal),
    staleTime: 15_000,
    gcTime: Infinity,
    retry: false,
    refetchInterval: 15_000,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  });
  if (isError) {
    return { writable: false, reason: "Config store unreachable", sources: data?.sources ?? {} };
  }
  const capability = data ?? OPTIMISTIC;
  return demo ? { ...capability, writable: false, reason: DEMO_READ_ONLY } : capability;
}
