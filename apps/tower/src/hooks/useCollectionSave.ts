import { useOwnerToast } from '@/lib/browser-context';
import { useTowerApi } from '@/lib/browser-context';
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  collectionOps,
  type CollectionChange,
  type ConfigRegister,
  type RegisterParams,
} from "@shared/config-registers";
import type { FileOp } from "@shared/changeset";
import {
  refreshConfigBackedQueries,
  useConfigSaveDelay,
} from "@/hooks/config-backed-queries";

import { type FieldSaveOutcome, refusalMessage, warnConfigExport } from "@/hooks/useConfigSave";

/**
 * The one way a row is added, changed or removed in the Tower. `useConfigSave`
 * is the same promise for a setting, and takes only the two invertible op
 * kinds; a row being added or removed is structural, so its inverse is a
 * different op kind at a different pointer, which is why this exists beside
 * it. One action, one changeset: an add is one insert, a remove is one delete
 * carrying the row as `expect`, an edit is one set carrying the old value, so
 * a stale row refuses its own write instead of a page's worth of them.
 * `collectionOps` builds the reverse op beside the forward one; it is a
 * guarded write in its own right, and it restores position: the undo of a
 * removal splices the row back in at the index it left. `config/pull.json` is
 * the one register that still appends, because nothing reads its order.
 */

/** Which reads a save refreshes, and how long it waits for the local Worker
 * to restart, are `config-backed-queries.ts`, the same declaration
 * `useConfigSave` reads. */

export interface CollectionSaveRequest {
  register: ConfigRegister;
  params?: RegisterParams;
  change: CollectionChange;
  /** What the toast names — the row the operator just touched. */
  label: string;
  /** The changeset slug, and the commit subject. */
  slug?: string;
  /** Write it somewhere else. The gallery passes a fake, so the demos are real
   * controls that never touch the operator's repo. */
  onSave?: (ops: FileOp[]) => Promise<void>;
}

/** The one write both hooks below share: the config door (and its
 * `config_changes` audit), then the refresh every config-backed read waits on. */
function useCollectionWrite() {
  const toast = useOwnerToast();
  const { saveConfig } = useTowerApi();
  const queryClient = useQueryClient();
  const delayMs = useConfigSaveDelay();

  return useCallback(
    async (ops: FileOp[], slug: string | undefined, onSave?: (ops: FileOp[]) => Promise<void>) => {
      if (onSave) {
        await onSave(ops);
        return;
      }
      warnConfigExport(await saveConfig(ops, slug), toast);
      refreshConfigBackedQueries(queryClient, delayMs);
    },
    [queryClient, delayMs],
  );
}

/**
 * One cell, its outcome beside it: the same op and inverse `collectionOps`
 * builds for the toast path, with the outcome travelling back to the cell
 * that made it. `useFieldConfigSave` is the same promise for a single
 * setting; the two answer in one shape (`InlineSaveState`).
 */
export function useFieldCollectionSave() {
  const write = useCollectionWrite();
  return useCallback(
    async ({ register, params = {}, change, slug, onSave }: CollectionSaveRequest): Promise<FieldSaveOutcome> => {
      const { op, undo } = collectionOps(register, params, change);
      try {
        await write([op], slug, onSave);
      } catch (err) {
        return { saved: false, refusal: refusalMessage(err) };
      }
      return {
        saved: true,
        undo: async () => {
          try {
            await write([undo], slug, onSave);
          } catch (err) {
            return { undone: false, refusal: refusalMessage(err) };
          }
          return { undone: true };
        },
      };
    },
    [write],
  );
}

export function useCollectionSave() {
  const toast = useOwnerToast();
  const write = useCollectionWrite();

  /** Returns whether the write landed, so a row can keep the operator's typed
   * value on screen when it did not. */
  return useCallback(
    async ({
      register,
      params = {},
      change,
      label,
      slug,
      onSave,
    }: CollectionSaveRequest): Promise<boolean> => {
      const { op, undo } = collectionOps(register, params, change);
      try {
        await write([op], slug, onSave);
      } catch (err) {
        toast.error(refusalMessage(err));
        return false;
      }
      toast.success(`Saved — ${label}`, {
        action: {
          label: "Undo",
          onClick: () => {
            void (async () => {
              try {
                await write([undo], slug, onSave);
              } catch (err) {
                toast.error(refusalMessage(err));
                return;
              }
              toast.success(`Reverted — ${label}`);
            })();
          },
        },
      });
      return true;
    },
    [write],
  );
}
