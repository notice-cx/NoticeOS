import { useTowerApi } from '@/lib/browser-context';
import { useQueryClient } from "@tanstack/react-query";
import type { FindingDecision } from "@/components/ExecutiveFindingsList";


/**
 * The decision write the asset page makes, bound to one asset.
 *
 * It resolves only after the store has the row, so the component can treat a
 * rejection as "roll the optimistic state back". Success invalidates the
 * asset-detail read, which is what turns a session-local mark into the payload
 * value every other screen sees on its next poll.
 *
 * There used to be a second writer here, recording a query handoff the moment
 * the operator copied its Markdown. It is gone (bead `ro-5e8.3`): copying is not
 * filing, and the query row now reads the bead the register holds instead of the
 * claim the copy made.
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
