import { useTowerApi } from '@/lib/browser-context';
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AssetDetailResponse, AssetDetailView } from "@shared/asset-detail-views";
import { ApiError } from "@/lib/api";

/** One tab's read of one asset. `["asset-detail", id]` stays the prefix, so
 * every existing invalidation of an asset's page still reaches every view. */
export function assetDetailKey(id: string, view: AssetDetailView) {
  return ["asset-detail", id, view] as const;
}

const POLL_MS = 60_000;
const STALE_MS = 30_000;

function retry(count: number, error: Error): boolean {
  if (error instanceof ApiError && error.status === 404) return false;
  return count < 1;
}

/** The newest read of this asset any tab has made, still in the cache. */
function newestRead(client: QueryClient, id: string): AssetDetailResponse | undefined {
  let newest: { data: AssetDetailResponse; at: number } | null = null;
  for (const query of client.getQueryCache().findAll({ queryKey: ["asset-detail", id] })) {
    const data = query.state.data as AssetDetailResponse | undefined;
    if (data && (newest === null || query.state.dataUpdatedAt > newest.at)) {
      newest = { data, at: query.state.dataUpdatedAt };
    }
  }
  return newest?.data;
}

/**
 * Polling read for the asset drill-down (desk-only). Same 60s cadence as the
 * Wall, keeping the last-good payload on a failed poll. A 404 (unknown asset) is
 * terminal — never retried — so the page can render its designed "no such asset"
 * state immediately. Any other failure gets one retry and then surfaces as
 * `error`: with no payload to hold, the page renders its designed failure state
 * (`refetch` is the operator's retry), never an endless "Loading…".
 *
 * One view per tab. The poll asks for the tab on screen,
 * cached under its own key, so returning to a tab shows its last read at once
 * while the next one loads. Leaving a tab stops its poll and cancels its read in
 * flight. Until a tab's own read has arrived — or if it fails — `data` is the
 * newest read of the SAME asset, whichever tab it was cut for: the header and
 * tab bar keep their facts, and the page draws the tab from it only if it
 * carries that tab's sections (`viewCovers`). Another asset's read is never
 * held.
 */
export function useAssetDetail(id: string, view: AssetDetailView) {
  const { fetchAssetDetail } = useTowerApi();
  const client = useQueryClient();
  const query = useQuery<AssetDetailResponse>({
    queryKey: assetDetailKey(id, view),
    queryFn: ({ signal }) => fetchAssetDetail(id, signal, view),
    refetchInterval: POLL_MS,
    staleTime: STALE_MS,
    retry,
  });
  return { ...query, data: query.data ?? newestRead(client, id) };
}

/** Start a tab's read before it is opened (a pointer resting on its tab, the
 * keyboard focusing it), so the switch is usually instant. A fresh cached read
 * is not asked for again. */
export function usePrefetchAssetDetail(id: string) {
  const { fetchAssetDetail } = useTowerApi();
  const client = useQueryClient();
  return (view: AssetDetailView) =>
    void client.prefetchQuery({
      queryKey: assetDetailKey(id, view),
      queryFn: ({ signal }) => fetchAssetDetail(id, signal, view),
      staleTime: STALE_MS,
      retry,
    });
}
