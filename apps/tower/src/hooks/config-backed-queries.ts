import type { QueryClient } from "@tanstack/react-query";
import { useConfigWritable } from "@/hooks/useConfigWritable";
// `GET /api/config`'s own word for where a document came from — the route
// answers it, so the type lives beside the fetch rather than being restated.
import type { ConfigSource } from "@/lib/api";

/**
 * Which reads a config save invalidates, declared once for both write paths
 * (`useConfigSave`, `useCollectionSave`). A key belongs here when its payload
 * is built from a config file, which for the Tower means the Worker route
 * behind it reads one of `vite.config.ts`'s injected `__…__` constants;
 * anything assembled from the store alone does not. Err towards listing: an
 * extra key is harmless, a missing one is a silently stale page.
 */
export const CONFIG_BACKED_QUERIES = [
  "wall",
  "asset-detail",
  "settings",
  "workflows",
  "financials",
  "integrations",
  "integration-providers",
  "task-source",
] as const;

/** Vite statically imports the editable config files, so a file save restarts
 * the local Worker and the payload every page reads is rebuilt a beat later.
 * Refetching immediately would only re-read the old bundle. */
export const WORKER_RESTART_MS = 1500;

/**
 * How long a save waits before refetching: none only when `GET /api/config`
 * says every document came from the store. A mixed or missing answer waits,
 * because the local dev lane reports no sources and really does restart.
 */
export function configSaveDelayMs(
  sources: Readonly<Record<string, ConfigSource>> | undefined,
): number {
  const answered = Object.values(sources ?? {});
  if (answered.length === 0) return WORKER_RESTART_MS;
  return answered.every((source) => source === "store") ? 0 : WORKER_RESTART_MS;
}

/** The wait this deployment's saves need, ready to hand to
 * `refreshConfigBackedQueries`. It rides the same one-per-session question the
 * disabled-field sentence comes from, so it costs no extra read. */
export function useConfigSaveDelay(): number {
  const { sources } = useConfigWritable();
  return configSaveDelayMs(sources);
}

/** Refresh every page whose payload was built from a config file. Both write
 * paths call this rather than walking the list themselves, so "which reads a
 * save invalidates" has exactly one implementation as well as one declaration. */
export function invalidateConfigBackedQueries(queryClient: QueryClient): void {
  for (const key of CONFIG_BACKED_QUERIES) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

/** The same refresh, once whatever the save set in motion has landed. `0` runs
 * it now rather than on the next tick of the event loop: a store save has
 * nothing to wait for, and deferring it anyway would be a shorter version of
 * the same wrong answer. */
export function refreshConfigBackedQueries(
  queryClient: QueryClient,
  afterMs: number,
): void {
  if (afterMs <= 0) {
    invalidateConfigBackedQueries(queryClient);
    return;
  }
  globalThis.setTimeout(() => invalidateConfigBackedQueries(queryClient), afterMs);
}
