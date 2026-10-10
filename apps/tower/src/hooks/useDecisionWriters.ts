import { useTowerApi } from '@/lib/browser-context';
import { useQueryClient } from "@tanstack/react-query";
import type { FindingDecision } from "@/components/ExecutiveFindingsList";


/**
 * The decision write the asset page makes, bound to one asset. It resolves
 * only after the store has the row, so the component can treat a rejection as
 * "roll the optimistic state back". Success invalidates the asset-detail
 * read, which turns a session-local mark into the payload value every other
 * screen sees on its next poll.
 */
export function useDecisionWriters(assetId: string) {
  const { clearDecision, recordDecision } = useTowerApi();
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["asset-detail", assetId] });

  return {
    /** Mark, dismiss, or (with `null`) restore one finding. */
    async decideFinding(
      key: string,
      status: FindingDecision | null,
    ): Promise<void> {
      if (status === null) {
        await clearDecision(assetId, "finding", key);
      } else {
        await recordDecision(assetId, { kind: "finding", key, status });
      }
      await refresh();
    },
  };
}
