import { useOwnerToast } from '@/lib/browser-context';
import { useTowerApi } from '@/lib/browser-context';
import { refusalMessage } from '@/lib/write-refusal';
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import type {
  DocumentFile,
  FileJsonDeleteOp,
  FileJsonInsertOp,
  FileOp,
  RegisterFile,
  SettingOp,
  StoreAssetSetOp,
} from "@shared/changeset";
import {
  refreshConfigBackedQueries,
  useConfigSaveDelay,
} from "@/hooks/config-backed-queries";
import { type ConfigSaveResult } from "@/lib/api";
import { copyText } from "@/lib/clipboard";

/** The one command that brings this machine's config files level with the
 * store after a save whose local export failed. */
export const CONFIG_EXPORT_COMMAND = "pnpm config:export";

/** A stored value and its local export are separate outcomes: the save's own
 * confirmation says the value landed, and this says the one thing that did
 * not, this machine's files, as its fix. Nothing here suggests the save
 * failed, so there is nothing to retry. */
export function warnConfigExport(result: ConfigSaveResult | void, notify = toast): void {
  if (result?.exported === false) {
    notify.warning("Local files not updated", {
      description: CONFIG_EXPORT_COMMAND,
      action: {
        label: "Copy command",
        onClick: () => {
          void copyText(CONFIG_EXPORT_COMMAND).catch(() => notify.error("Copy failed — select the text instead"));
        },
      },
      duration: Infinity,
      closeButton: true,
    });
  }
}

/**
 * The one way a setting is saved in the Tower: apply, confirm, offer Undo, and
 * say plainly when it was refused. Undo over confirm: there is no "are you
 * sure", and Undo is the same write with the values swapped and `expect` set
 * to what was just saved, so it is refused in turn if something else moved
 * the value in between.
 */

/** Where an op is owned decides which lane writes it: files go to the local
 * write lane in one changeset; the store columns go to the Worker, one call
 * each, because the store is reachable from every deployment. */
function splitOps(ops: SettingOp[]): {
  fileOps: FileOp[];
  storeOps: StoreAssetSetOp[];
} {
  const fileOps: FileOp[] = [];
  const storeOps: StoreAssetSetOp[] = [];
  for (const op of ops) {
    if (op.kind === "store-asset-set") storeOps.push(op);
    else fileOps.push(op);
  }
  return { fileOps, storeOps };
}

/**
 * The same edit, backwards. `expect` becomes the value just written, so an Undo
 * pressed after somebody else changed the same field is refused rather than
 * quietly reverting their work too. A first write inverts into a delete, and a
 * delete back into a first write: the delete expects exactly the value the
 * save wrote, and the set back expects the key to be absent.
 */
function invert(op: SettingOp): SettingOp {
  if (op.kind === "file-json-delete") {
    return { kind: "file-json-set", file: op.file, pointer: op.pointer, expectAbsent: true, value: op.expect };
  }
  if (op.kind === "file-json-set" && op.expect === undefined) {
    return {
      kind: "file-json-delete",
      // The boundary between two vocabularies, the same one `collectionOps`
      // crosses: a set may name a wholesale-editable file or a register file,
      // and a delete only a register or a declared document. A first write is
      // licensed only at a declared register field or a declared document's own
      // pointer (`scripts/config-documents.mjs` `firstWriteRefusal`), so the
      // file this op names is one of those two by construction.
      file: op.file as RegisterFile | DocumentFile,
      pointer: op.pointer,
      expect: op.value,
    };
  }
  return { ...op, expect: op.value, value: op.expect };
}

export interface SaveRequest {
  ops: SettingOp[];
  /** What the toast names — the field the operator just changed. */
  label: string;
  /** The changeset slug for file ops; also the commit subject. */
  slug?: string;
  /**
   * Write the timeline event this save is, once the store has actually moved.
   * It receives the ops that landed, so the Undo path records the move back.
   * A refusal here is reported on its own line and never turns a save that
   * worked into a save that failed.
   */
  record?: (written: SettingOp[]) => Promise<void>;
  /**
   * The way back, when it is not every op inverted. A data source declined
   * from a blank note cannot have the blank written back, so its Undo puts the
   * posture back and leaves the reason as the cell's history (`undeclineOps`,
   * `shared/lane-decline.ts`). Guarded exactly as an inverse is.
   */
  undo?: SettingOp[];
}

/** A save confirmed in a toast that carries its Undo — every editor outside
 * `/settings`, which confirms beside the field instead (`useFieldConfigSave`). */
export function useConfigSave() {
  const toast = useOwnerToast();
  const write = useConfigWrite();

  /** Returns whether the write landed, so a field can keep the operator's typed
   * value on screen when it did not. */
  return useCallback(
    async ({ ops, label, slug, record, undo }: SaveRequest): Promise<boolean> => {
      try {
        await write(ops, slug, record);
      } catch (err) {
        toast.error(refusalMessage(err));
        return false;
      }
      // The way back: every op this hook takes has one, including the save
      // that filled in a field nothing had written yet.
      const back = undo ?? ops.map(invert);
      toast.success(`Saved — ${label}`, {
        action: {
          label: "Undo",
          onClick: () => {
            void (async () => {
              try {
                await write(back, slug, record);
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

/** What a field shows after an inline save: the way back, beside the change. */
export interface InlineSaved {
  /** The same write reversed and guarded the same way. False when refused —
   * the refusal has already been said in a toast. */
  undo: () => Promise<boolean>;
}

/**
 * A save as the field reports it: it landed, with the way back, or it did
 * not, with the refusal's own words for the field to show beside itself.
 * Nothing here speaks in a toast: the field is where the operator made the
 * change, so the field is where its outcome is said.
 */
export type FieldSaveOutcome =
  | { saved: true; undo: () => Promise<FieldUndoOutcome> }
  | { saved: false; refusal: string };

/** An Undo as the field reports it: back where it was, or refused and why. */
export type FieldUndoOutcome = { undone: true } | { undone: false; refusal: string };

/**
 * The same save, its whole outcome beside the field: the one write every
 * setting shares (`useConfigWrite`) and the one inverse (`invert`), with a
 * refusal coming back to the field as a short state instead of a corner toast.
 */
export function useFieldConfigSave() {
  const write = useConfigWrite();
  return useCallback(
    async ({ ops, slug, record }: SaveRequest): Promise<FieldSaveOutcome> => {
      try {
        await write(ops, slug, record);
      } catch (err) {
        return { saved: false, refusal: refusalMessage(err) };
      }
      const back = ops.map(invert);
      return {
        saved: true,
        undo: async () => {
          try {
            await write(back, slug, record);
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

/**
 * The same save, confirmed beside the field: "Saved" and an Undo next to the
 * control rather than a toast. A failed local export is a different subject,
 * this machine's files, and keeps its toast. This form is for a panel that
 * confirms by its rows' own states and has no field to put a refusal beside,
 * so a refusal is still toasted here; a field uses {@link useFieldConfigSave}.
 */
export function useInlineConfigSave() {
  const toast = useOwnerToast();
  const save = useFieldConfigSave();
  return useCallback(
    async (request: SaveRequest): Promise<InlineSaved | null> => {
      const outcome = await save(request);
      if (!outcome.saved) {
        toast.error(outcome.refusal);
        return null;
      }
      return {
        undo: async () => {
          const back = await outcome.undo();
          if (!back.undone) toast.error(back.refusal);
          return back.undone;
        },
      };
    },
    [save],
  );
}

/**
 * The write both hooks above share: files through the lane, store columns
 * through the Worker, the timeline record after, and the refresh. Which reads
 * a save refreshes, and how long it waits, come from `config-backed-queries.ts`,
 * which `useCollectionSave` reads too: a file save restarts the local Worker
 * and a store-backed save restarts nothing, so `useConfigSaveDelay` answers
 * which this deployment just did.
 */
function useConfigWrite() {
  const toast = useOwnerToast();
  const { saveConfig, patchAssetColumn } = useTowerApi();
  const queryClient = useQueryClient();
  const delayMs = useConfigSaveDelay();

  const refresh = useCallback(
    (afterMs: number) => refreshConfigBackedQueries(queryClient, afterMs),
    [queryClient],
  );

  return useCallback(
    async (
      ops: SettingOp[],
      slug?: string,
      record?: (written: SettingOp[]) => Promise<void>,
    ) => {
      const { fileOps, storeOps } = splitOps(ops);
      if (fileOps.length > 0) warnConfigExport(await saveConfig(fileOps, slug), toast);
      for (const op of storeOps) {
        await patchAssetColumn(op.asset, op.column, op.value, op.expect);
      }
      if (record) {
        // After the write, never instead of it: an event recorded for a change
        // the store refused would be a timeline of things that did not happen.
        try {
          await record(ops);
        } catch (err) {
          toast.error(`Not recorded on the timeline — ${refusalMessage(err)}`);
        }
      }
      // A store column write (`store-asset-set`) touches no file, so it
      // refreshes immediately; a `file-json-set` may not have touched one either.
      refresh(fileOps.length > 0 ? delayMs : 0);
    },
    [refresh, delayMs],
  );
}

/**
 * A landmark: one whole optional block, added or taken away. A set at
 * `/countdown/emoji` is refused while there is no countdown, so the countdown
 * is added and removed whole, at its own pointer, through the two structural
 * op kinds. Undo is still real: the inverse of adding a block is removing
 * exactly the block that was added, guarded by the value on the other side.
 * The three fields move together because a countdown with a label and no
 * moment is a mistake on a television.
 */
export interface LandmarkSaveRequest {
  op: FileJsonInsertOp | FileJsonDeleteOp;
  /** What the toast names — the thing that was added or taken away. */
  label: string;
  /** The changeset slug; also the commit subject. */
  slug: string;
}

function invertLandmark(
  op: FileJsonInsertOp | FileJsonDeleteOp,
): FileJsonInsertOp | FileJsonDeleteOp {
  return op.kind === "file-json-insert"
    ? { kind: "file-json-delete", file: op.file, pointer: op.pointer, expect: op.value }
    : { kind: "file-json-insert", file: op.file, pointer: op.pointer, value: op.expect };
}

export function useLandmarkSave() {
  const toast = useOwnerToast();
  const { saveConfig } = useTowerApi();
  const queryClient = useQueryClient();
  const delayMs = useConfigSaveDelay();

  const write = useCallback(
    async (op: FileJsonInsertOp | FileJsonDeleteOp, slug: string) => {
      warnConfigExport(await saveConfig([op], slug), toast);
      // The same reads and the same wait the hook above uses: a landmark lives
      // in a config file like any setting, so what a save of one invalidates and
      // how long it waits for the restart are decided in one place.
      refreshConfigBackedQueries(queryClient, delayMs);
    },
    [queryClient, delayMs],
  );

  return useCallback(
    async ({ op, label, slug }: LandmarkSaveRequest): Promise<boolean> => {
      try {
        await write(op, slug);
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
                await write(invertLandmark(op), slug);
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

/** What a refusal says out loud. A stale value is the one case with its own
 * sentence, because the operator's next move is different: reload, do not retry. */
export { refusalMessage } from '@/lib/write-refusal';
