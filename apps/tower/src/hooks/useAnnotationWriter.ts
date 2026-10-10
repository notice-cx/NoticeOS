import { useTowerApi } from '@/lib/browser-context';
import { useQueryClient } from "@tanstack/react-query";
import type { AnnotationKind } from "@shared/asset-detail";


/**
 * The asset page's timeline write, bound to one asset. Resolves only after
 * the store has the row and the detail read has been invalidated, so the caller
 * can treat a rejection as "the event was not recorded" and leave the operator's
 * typed text where it is.
 */
export function useAnnotationWriter(assetId: string) {
  const { createAnnotation } = useTowerApi();
  const queryClient = useQueryClient();

  return async function recordAnnotation(input: {
    kind: AnnotationKind;
    at?: string;
    note?: string;
    /** The task that caused this change, as its id. Part of the store's
     * identity `(asset, at, kind, ref)`, so two deploys at the same instant
     * for two different tasks are two rows rather than one. */
    ref?: string | null;
  }): Promise<void> {
    await createAnnotation(assetId, input);
    await queryClient.invalidateQueries({
      queryKey: ["asset-detail", assetId],
    });
  };
}
