// Which legal entity owns an asset: the reads and the writes, in one place. The
// fact lives in `config/entities.json` as an edge stored on the entity (a row
// owns a list of asset ids; `config/entities.README.md` says why), and every
// surface that shows it asks this module.

import type { FileJsonSetGuardedOp, FileJsonSetOp, JsonValue } from "./changeset";
import { CONFIG_REGISTERS, resolveContainer } from "./config-registers";

/** The file that owns the concept — the path an owner chip prints. */
export const ENTITIES_OWNER = "config/entities.json";

/** One row of `config/entities.json` `/entities`, as the declaration describes
 * it. `form`, `jurisdiction` and `assets` are absent rather than blank when
 * nobody has said: an entity whose paperwork is pending is a real state, and so
 * is one that owns nothing yet. */
export interface EntityRow {
  slug: string;
  name: string;
  form?: string;
  jurisdiction?: string;
  assets?: string[];
}

/** The asset ids a row claims, however the file spells the absence. */
export function entityAssets(row: EntityRow | null | undefined): string[] {
  return Array.isArray(row?.assets) ? row.assets : [];
}

/**
 * The entity that owns this asset, or `null` — *nobody has said yet*, which is
 * the starting state of every asset and not a gap in the data.
 *
 * The first row wins where two claim the same asset (only a hand-edited file
 * can), so the answer is definite.
 */
export function entityOfAsset(
  rows: readonly EntityRow[] | null | undefined,
  assetId: string,
): EntityRow | null {
  return (rows ?? []).find((row) => entityAssets(row).includes(assetId)) ?? null;
}

/** How an entity is named on screen: its own name, and the paperwork behind it
 * where there is any. One spelling, so the picker, the table and the asset's
 * card all say the same thing. */
export function entityLabel(row: EntityRow): string {
  const paperwork = [row.form, row.jurisdiction].filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  return paperwork.length === 0 ? row.name : `${row.name} · ${paperwork.join(", ")}`;
}

/** The pointer one row's asset list lives at. Built from the declaration rather
 * than written out again, so the container this sends to and the container the
 * write lane licenses are the same string. */
function assetsPointer(index: number): string {
  return `${resolveContainer(CONFIG_REGISTERS.entities, {})}/${index}/assets`;
}

/**
 * Taking one asset off whoever owns it: one op, or `null` when nobody does.
 * The membership is a string in another row's list, so removing it is a guarded
 * set on that row's `assets`, never a row delete: the entity outlives every
 * asset it owns. A site delete uses this alone; {@link entityMoveOps} builds on it.
 */
export function entityReleaseOp(
  rows: readonly EntityRow[] | null | undefined,
  assetId: string,
): FileJsonSetGuardedOp | null {
  const all = rows ?? [];
  const index = all.findIndex((row) => entityAssets(row).includes(assetId));
  const row = all[index];
  if (row === undefined) return null;
  return {
    kind: "file-json-set",
    file: ENTITIES_OWNER,
    pointer: assetsPointer(index),
    expect: entityAssets(row) as JsonValue,
    value: entityAssets(row).filter((id) => id !== assetId) as JsonValue,
  };
}

/**
 * Moving one asset between entities: up to two sets in one changeset, off the
 * row that has it and onto the row picked, so the asset is never left between.
 * Each set guards on the list it was rendered from; a row that has never owned
 * anything has no `assets` key, so its first asset is an `expectAbsent` set.
 * `toSlug` of `null` means nobody; picking the current owner writes nothing.
 */
export function entityMoveOps(
  rows: readonly EntityRow[],
  assetId: string,
  toSlug: string | null,
): FileJsonSetOp[] {
  const from = rows.findIndex((row) => entityAssets(row).includes(assetId));
  const to = toSlug === null ? -1 : rows.findIndex((row) => row.slug === toSlug);
  if (from === to) return [];

  const ops: FileJsonSetOp[] = [];
  const off = entityReleaseOp(rows, assetId);
  if (off !== null) ops.push(off);

  const toRow = rows[to];
  if (toRow !== undefined) {
    const held = toRow.assets;
    const next = [...entityAssets(toRow), assetId] as JsonValue;
    ops.push(
      Array.isArray(held)
        ? {
            kind: "file-json-set",
            file: ENTITIES_OWNER,
            pointer: assetsPointer(to),
            expect: held as JsonValue,
            value: next,
          }
        : {
            kind: "file-json-set",
            file: ENTITIES_OWNER,
            pointer: assetsPointer(to),
            expectAbsent: true,
            value: next,
          },
    );
  }
  return ops;
}
