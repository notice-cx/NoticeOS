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
 * The one way a ROW is added, changed or removed in the Tower (bead
 * `ro-x5gu.1`).
 *
 * `useConfigSave` is the same promise for a SETTING: apply, confirm, offer Undo,
 * say plainly when it was refused. It deliberately takes only the two invertible
 * op kinds (`file-json-set`, `store-asset-set`) because its Undo is the same op
 * with `expect` and `value` swapped — and a row being added or removed is
 * STRUCTURAL, so its inverse is a DIFFERENT op kind at a different pointer.
 * That is the whole reason this exists beside it rather than inside it.
 *
 * ONE ACTION, ONE CHANGESET. An add is one insert, a remove is one delete
 * carrying the row as `expect`, an edit is one set carrying the old value — so
 * the archive reads as the operator's own history rather than as a batch, and a
 * stale row refuses its own write instead of a page's worth of them.
 *
 * WHAT UNDO IS. `collectionOps` builds the reverse op beside the forward one, so
 * the way back is decided at the same moment and from the same row. It is a
 * guarded write in its own right: an Undo pressed after somebody else moved that
 * row is refused rather than quietly reverting their work too. And it restores
 * POSITION (bead `ro-asj9`): a delete splices, so the undo of a removal splices
 * the row back in at the index it left, which is what RFC 6902's `add` means for
 * an array (config/changesets/README.md). `config/pull.json` is the one register
 * that still appends, because nothing reads the order of the endpoints in it.
 */

/** WHICH READS A SAVE REFRESHES, and how long it waits for the local Worker to
 * restart, are `config-backed-queries.ts` — the same declaration `useConfigSave`
 * reads (bead `ro-ina0`). Two copies of one fact drifted apart here once
 * already, and the stale copy was the one nobody was looking at. The wait is a
 * question rather than a constant since D22 (bead `ro-ssgu`): a store-backed
 * save restarts nothing, so there is nothing for it to wait out. */

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
 * ONE CELL, ITS OUTCOME BESIDE IT (bead `ro-ujb9.96.7.12`).
 *
 * The same op and the same exact inverse `collectionOps` builds for the toast
 * path, through the same write — only the outcome travels back to the cell
 * that made it instead of into a corner toast: saved with its Undo, or refused
 * with the refusal's own words. `useFieldConfigSave` is the same promise for a
 * single setting; the two answer in one shape so a field and a cell say
 * "Saved · Undo" and "Not saved" the same way (`InlineSaveState`).
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
