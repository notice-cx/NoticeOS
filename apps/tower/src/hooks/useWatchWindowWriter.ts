import { useTowerApi } from '@/lib/browser-context';
import { useQueryClient } from "@tanstack/react-query";


/**
 * The asset page's pre-registration, bound to one asset.
 * Resolves only after the store has the row and the detail read has been
 * invalidated, so the caller can treat a rejection as "nothing was registered"
 * and leave the operator's choices exactly where they are.
 */
export function useWatchWindowWriter(assetId: string) {
  const { createWatchWindow } = useTowerApi();
  const queryClient = useQueryClient();

  return async function registerWatch(
    body: Record<string, unknown>,
  ): Promise<void> {
    await createWatchWindow(assetId, body);
    await queryClient.invalidateQueries({
      queryKey: ["asset-detail", assetId],
    });
  };
}
