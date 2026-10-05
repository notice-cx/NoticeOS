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

/**
 * A stored value and its local export are separate outcomes (bead
 * `ro-ujb9.96.6.3`): the save's own confirmation says the value landed, and
 * this says the one thing that did not — this machine's files — as its fix.
 *
 * It used to be 25 words telling the operator to run a command, that the value
 * was already stored and not to retry. Now the title names the state, the
 * description IS the command, and the action copies it: nothing to read, and
 * nothing here suggests the save failed, so there is nothing to retry.
 */
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
 * The one way a setting is saved in the Tower (D18, bead `ro-pbzu.5`).
 *
 * Every editable field — a knob on the asset page, the countdown on Home, the
 * Settings page when it lands — goes through here, so "what a Save does" has one
 * answer: apply, confirm, offer Undo, and say plainly when it was refused.
 *
 * UNDO OVER CONFIRM (docs/15 principle 5). There is no "are you sure": the save
 * happens, and the toast carries the way back. Undo is not a special path — it
 * is the same write with the values swapped, `expect` set to what was just
 * saved, so it is refused in turn if something else moved the value in between.
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
 * quietly reverting their work too.
 *
 * A FIRST WRITE INVERTS INTO A DELETE, and a delete back into a first write
 * (bead `ro-pkpz`). Its guard was "nothing is there", so the way back is taking
 * the key away again — which a set cannot do, and which nothing in the
 * vocabulary licensed at a field until the pipeline gained
 * `file-json-delete` there. Until then this answered `null` and the Sources tab
 * was the one Save surface in the Tower with no Undo (docs/15 principle 5).
 *
 * The guard survives the round trip in both directions: the delete expects
 * exactly the value the save wrote, and the set back expects the key to be
 * absent — so an Undo pressed after somebody else touched the field is refused
 * rather than quietly undoing their work too.
 */
function invert(op: SettingOp): SettingOp {
  if (op.kind === "file-json-delete") {
    return { kind: "file-json-set", file: op.file, pointer: op.pointer, expectAbsent: true, value: op.expect };
  }
  if (op.kind === "file-json-set" && op.expect === undefined) {
    return {
      kind: "file-json-delete",
      // The boundary between two vocabularies, the same one `collectionOps`
      // crosses: a set may name a wholesale-editable file OR a register file,
      // and a delete only a register or a declared document. A first write is
      // licensed at nothing but a declared register field or a declared
      // document's own pointer (`scripts/config-documents.mjs`
      // `firstWriteRefusal`, bead `ro-ujb9.96.8`), so the file this op names is
      // one of those two by construction — a set anywhere else could never have
      // carried `expectAbsent` past validation.
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
   * Write the timeline event this save IS, once the store has actually moved
   * (bead `ro-3085`: a lifecycle stage change is an event on the asset).
   *
   * It receives the ops that landed, so the UNDO path records the move back
   * rather than leaving a timeline claiming a change the operator took away. A
   * refusal here is reported on its own line and never turns a save that worked
   * into a save that failed — the value moved; only the record of it did not.
   */
  record?: (written: SettingOp[]) => Promise<void>;
  /**
   * The way back, when it is NOT every op inverted (bead `ro-ujb9.96.7.13`).
   * A data source declined from a blank note cannot have the blank written
   * back — the register refuses one — so its Undo puts the posture back and
   * leaves the reason as the cell's history (`undeclineOps`,
   * `shared/lane-decline.ts`). Guarded exactly as an inverse is: each op
   * expects what the save just wrote.
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
      // The way back — and since bead `ro-pkpz` every op this hook takes has
      // one, including the save that filled in a field nothing had written yet.
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
 * A save as the FIELD reports it (bead `ro-ujb9.96.7.12`): it landed, with the
 * way back — or it did not, with the refusal's own words for the field to show
 * beside itself. Nothing here speaks in a toast: the field is where the operator
 * made the change, so the field is where its outcome is said (one status per
 * subject, doc 21 principle 3b).
 */
export type FieldSaveOutcome =
  | { saved: true; undo: () => Promise<FieldUndoOutcome> }
  | { saved: false; refusal: string };

/** An Undo as the field reports it: back where it was, or refused and why. */
export type FieldUndoOutcome = { undone: true } | { undone: false; refusal: string };

/**
 * THE SAME SAVE, ITS WHOLE OUTCOME BESIDE THE FIELD (bead `ro-ujb9.96.7.12`).
 *
 * The one write every setting shares (`useConfigWrite` below — the config door
 * and its `config_changes` audit), and the one inverse (`invert`): an Undo is
 * the same write with the values swapped and `expect` set to what was just
 * saved, so an Undo pressed after somebody else moved the value is refused
 * rather than quietly reverting them. What is new is only WHERE a refusal is
 * said: it comes back to the field as a short state instead of a corner toast
 * the operator has to connect to the control they just touched.
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
 * THE SAME SAVE, CONFIRMED BESIDE THE FIELD (bead `ro-ujb9.96.6.3`).
 *
 * `/settings` confirms where the change was made — "Saved" and an Undo next to
 * the control, as GitLab Pajamas does for a single field
 * (docs/briefs/2026-09-23-ux-prior-art.md#settings-save-undo) — rather than in
 * a toast in the corner that also carries the Undo. Same write, same inverse,
 * same refusals; only where the confirmation lives differs, so the field is the
 * one place the save's state is shown (one status per subject). A failed local
 * export is a different subject — this machine's files — and keeps its toast.
 *
 * This form is for a PANEL that confirms by its rows' own states (the connect
 * panel's Start) and has no field to put a refusal beside, so a refusal is
 * still toasted here. A field uses {@link useFieldConfigSave} and says it
 * itself.
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
 * through the Worker, the timeline record after, and the refresh.
 *
 * WHICH READS A SAVE REFRESHES is `config-backed-queries.ts`, which
 * `useCollectionSave` reads too (bead `ro-ina0`). This hook used to keep its own
 * copy of that list, and the copies had drifted: a setting saved here left
 * `/financials` showing the figure it had just been told to change.
 *
 * HOW LONG IT WAITS comes from the same module for the same reason, and since
 * D22 it is a question rather than a constant (bead `ro-ssgu`): a file save
 * restarts the local Worker and a store-backed save restarts nothing, so
 * `useConfigSaveDelay` answers which this deployment just did.
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
      // A store COLUMN write (`store-asset-set`) never touched a file even
      // before D22, so it has always refreshed immediately. What is new is that
      // a `file-json-set` may not have touched one either.
      refresh(fileOps.length > 0 ? delayMs : 0);
    },
    [refresh, delayMs],
  );
}

/**
 * A LANDMARK: one whole optional block, added or taken away (bead `ro-fqag`).
 *
 * `useConfigSave` above takes only the ops whose inverse is the same op with
 * `expect` and `value` swapped, which is what makes its Undo honest. A block a
 * file does not have yet cannot be written that way — "we never create
 * structure" means a set at `/countdown/emoji` is refused while there is no
 * countdown — so the countdown is added and removed WHOLE, at its own pointer,
 * through the two structural op kinds the changeset vocabulary already has.
 *
 * Undo is still real here, and that is why this lives beside the hook above
 * rather than calling `saveConfig` from a form: the inverse of adding a block is
 * removing exactly the block that was added, and of removing one is putting back
 * exactly the block that was there. One op each way, guarded by the value on the
 * other side, so an Undo pressed after somebody else touched the same landmark
 * is refused rather than quietly overwriting them.
 *
 * The three fields move together because they ARE one thing (bead `ro-py40`): a
 * countdown with a label and no moment is not half a countdown, it is a mistake
 * on a television.
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
