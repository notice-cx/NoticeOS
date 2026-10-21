import type { QueryClient } from "@tanstack/react-query";
import type { ChangesetOp, FileOp } from "@shared/changeset";
import { useConfigWritable } from "@/hooks/useConfigWritable";
// `GET /api/config`'s own word for where a document came from — the route
// answers it, so the type lives beside the fetch rather than being restated.
import type { ConfigSource } from "@/lib/api";

/** All config consumers, including the fallback for unclassified writes. */
export const CONFIG_BACKED_QUERIES = [
  "wall",
  "asset-detail",
  "settings",
  "workflows",
  "financials",
  "integrations",
  "integration-providers",
  "task-source",
  "work",
  "wall-feed",
] as const;

type ConfigQueryFamily = (typeof CONFIG_BACKED_QUERIES)[number];

/** Document dependencies of the payloads in worker/stored-read-route.ts,
 * integrationsDeps, integration-summary-route.ts and the native workflow read.
 * Whole documents are the boundary: new fields in a known document retain
 * its consumers; new documents and non-file writes keep the broad fallback. */
const DOCUMENT_QUERIES: Partial<Record<FileOp["file"], readonly ConfigQueryFamily[]>> = {
  "config/constants.json": ["wall", "asset-detail", "settings", "workflows", "financials", "integrations", "integration-providers", "work", "wall-feed"],
  "config/pull.json": ["wall", "asset-detail", "settings", "integrations"],
  "config/integrations.json": ["wall", "asset-detail", "settings", "integrations", "integration-providers"],
  "config/counters.json": ["wall", "asset-detail"],
  "config/tower.json": ["wall", "settings"],
  "config/serp-panel.json": ["wall", "asset-detail", "integrations"],
  "config/signal-panels.json": ["asset-detail", "settings"],
  "config/value-events.json": ["asset-detail"],
  "config/ga4-custom-dimensions.json": ["asset-detail"],
  "config/domain-costs.json": ["financials"],
  "config/recurring-costs.json": ["financials"],
  "config/entities.json": ["settings"],
  "config/beads.json": ["settings", "task-source", "work"],
};

/** Forward and Undo operations use the same union, with no caller-owned lists. */
export function affectedConfigBackedQueries(ops?: readonly ChangesetOp[]): readonly ConfigQueryFamily[] {
  if (!ops?.length) return CONFIG_BACKED_QUERIES;
  const affected = new Set<ConfigQueryFamily>();
  for (const op of ops) {
    if (op.kind !== "file-json-set" && op.kind !== "file-json-insert" && op.kind !== "file-json-delete") {
      return CONFIG_BACKED_QUERIES;
    }
    if (!Object.hasOwn(DOCUMENT_QUERIES, op.file)) return CONFIG_BACKED_QUERIES;
    const consumers = DOCUMENT_QUERIES[op.file];
    if (!consumers) return CONFIG_BACKED_QUERIES;
    for (const key of consumers) affected.add(key);
  }
  return [...affected];
}

/** Archive and Restore change these store-backed lists even when their rows did not change. */
export function refreshAssetLifecycleQueries(queryClient: QueryClient): void {
  for (const key of ["work", "alert-history", "wall-feed"]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

/** Vite statically imports the editable config files, so a file save restarts
 * the local Worker and the payload every page reads is rebuilt a beat later.
 * Refetching immediately would only re-read the old bundle. */
export const WORKER_RESTART_MS = 1500;

/**
 * How long a save waits before refetching: none only when `GET /api/config`
 * says every document came from the store. A mixed or missing answer waits,
 * because a document read from the compiled copy changes only after the local
 * Worker restarts.
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

/** With no operations, preserve broad refreshes for writes outside changesets. */
export function invalidateConfigBackedQueries(queryClient: QueryClient, ops?: readonly ChangesetOp[]): void {
  for (const key of affectedConfigBackedQueries(ops)) {
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
  ops?: readonly ChangesetOp[],
): void {
  if (afterMs <= 0) {
    invalidateConfigBackedQueries(queryClient, ops);
    return;
  }
  globalThis.setTimeout(() => invalidateConfigBackedQueries(queryClient, ops), afterMs);
}
