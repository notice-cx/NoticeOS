import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { useOwnerMutation, useOwnerToast, useTowerApi } from "@/lib/browser-context";

/**
 * The one write that changes a site's place in the list every surface reads:
 * `asset` takes the place `to` holds (`moveAsset`), the list is read again,
 * and the toast carries an Undo that moves it back to the site now in its old
 * place, guarded by the order this move left. One move at a time: a second
 * press while one is in flight is dropped rather than queued against a list
 * that is about to change.
 */
export function useSiteMove(): {
  move: (asset: string, to: string) => Promise<boolean>;
  pending: boolean;
} {
  const api = useTowerApi();
  const queryClient = useQueryClient();
  const toast = useOwnerToast();
  const busy = useRef(false);
  const mutation = useOwnerMutation({
    mutationFn: async ({ asset, to, expectRevision }: { asset: string; to: string; expectRevision?: string }) => {
      const result = await api.moveAsset(asset, to, expectRevision);
      await queryClient.invalidateQueries({ queryKey: ["wall"] });
      return result;
    },
  });
  const { mutateAsync } = mutation;

  const save = useCallback(
    async (asset: string, to: string, expectRevision?: string): Promise<boolean> => {
      if (busy.current) return false;
      busy.current = true;
      try {
        const result = await mutateAsync({ asset, to, expectRevision });
        toast.success(expectRevision ? "Asset order restored" : "Asset order saved", {
          ...(expectRevision === undefined && result.undoTo !== null
            ? { action: { label: "Undo", onClick: () => { void save(asset, result.undoTo!, result.revision); } } }
            : {}),
        });
        return true;
      } catch (error) {
        toast.error(error instanceof ApiError && error.code === "expect_mismatch"
          ? "Asset order changed elsewhere. Refresh before moving again."
          : "Asset order could not be confirmed. Refresh before retrying.");
        await queryClient.invalidateQueries({ queryKey: ["wall"] });
        return false;
      } finally {
        busy.current = false;
      }
    },
    [mutateAsync, queryClient, toast],
  );

  return { move: useCallback((asset: string, to: string) => save(asset, to), [save]), pending: mutation.isPending };
}
