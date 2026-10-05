import type { QueryClient } from "@tanstack/react-query";
import { useConfigWritable } from "@/hooks/useConfigWritable";
// `GET /api/config`'s own word for where a document came from — the route
// answers it, so the type lives beside the fetch rather than being restated.
import type { ConfigSource } from "@/lib/api";

/**
 * WHICH READS A CONFIG SAVE INVALIDATES — declared ONCE (bead `ro-ina0`).
 *
 * `useConfigSave` (a setting) and `useCollectionSave` (a row) are two write
 * paths onto the same files, so they refresh the same pages. They used to keep
 * two copies of this list and the copies had already drifted: a save through the
 * setting path left `/financials` showing the cost it was just told to change.
 *
 * The rule for membership is mechanical — a key belongs here when its payload
 * is BUILT FROM A CONFIG FILE, which for the Tower means the Worker route
 * behind it reads one of `vite.config.ts`'s injected `__…__` constants. Anything
 * assembled from the store alone (`/api/work`, `/api/alerts/*`) does not, because
 * a config save cannot move it.
 *
 * Each key names what makes it config-backed, so the next person adding a route
 * can tell in one read whether it belongs:
 *
 *  - `wall`                  — counters, tower, integrations, pull, SERP panel
 *  - `asset-detail`          — the same set plus signal panels and value events
 *  - `settings`              — a PURE builder over config; nothing else
 *  - `financials`            — domain costs and recurring costs
 *  - `integrations`          — integrations, pull, caps, SERP panel
 *  - `integration-providers` — the provider inventory in `integrations.json`
 *  - `task-source`           — the task projects saved in `beads.json`
 *
 * A key that no read uses is harmless (invalidation of an absent key is a
 * no-op), which is the direction to err in: a missing key is a stale page the
 * operator has no reason to suspect.
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

/**
 * Vite statically imports the editable config files, so a FILE save RESTARTS
 * the local Worker and the payload every page reads is rebuilt a beat later.
 * Refetching immediately would only re-read the old bundle.
 *
 * One constant rather than one per hook, for the same reason as the list: the
 * two write paths wait on the same restart.
 */
export const WORKER_RESTART_MS = 1500;

/**
 * HOW LONG A SAVE WAITS BEFORE REFETCHING — declared once, beside the list it
 * refetches (bead `ro-ssgu`).
 *
 * Both write paths used to wait `WORKER_RESTART_MS` unconditionally, because
 * before D22 every save was a file save and every file save restarted Vite.
 * A store-backed save changes no file, restarts nothing, and has nothing to
 * wait for — so on a seeded install that second and a half was a second and a
 * half of stale figures on screen for no reason at all.
 *
 * THE ANSWER IS THE SOURCE, NOT THE DEPLOYMENT, and it is read from
 * `GET /api/config` rather than guessed: only when EVERY document the Tower is
 * reading came from the store is there no file in the loop. A mixed answer
 * waits, and so does an answer that has not arrived — the local dev lane does
 * not report sources at all, and it is the one deployment that really does
 * restart, because it exports each stored document back to its file after the
 * store takes the write.
 *
 * Erring toward the wait is the cheap direction: waiting when nothing restarted
 * costs a second, and refetching early costs the operator a figure that is
 * wrong with no sign that it is.
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
