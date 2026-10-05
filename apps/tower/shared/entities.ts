// WHICH LEGAL ENTITY OWNS AN ASSET — the reads and the writes, in one place
// (bead `ro-aodz`).
//
// The fact lives in `config/entities.json` as an EDGE stored once, on the
// entity: a row owns a list of asset ids, and an asset's owner is read back out
// of those lists. `config/entities.README.md` says why that direction and not
// the other; this module is what every surface asks, so the three that show it —
// `/settings`, an asset's Identity card, and the add-asset wizard's review —
// cannot each grow their own idea of what "owned" means.
//
// It imports nothing from React and nothing from `src/`, exactly like
// `shared/asset-wizard.ts` beside it, so "the ops a move would send" is a value
// a test can assert rather than something that only exists inside a click.

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
 * The FIRST row wins where two claim the same asset. No surface can create
 * that: `/settings` does not offer an entity's asset list, and the asset's own
 * card moves it as one change off the old list and onto the new
 * (`entityMoveOps`). A file hand-edited into it should still render something
 * definite rather than flickering between two answers.
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
 * TAKING ONE ASSET OFF WHOEVER OWNS IT — one op, or `null` when nobody does.
 *
 * The membership is a STRING IN ANOTHER ROW'S LIST, so removing it is a set on
 * that row's `assets` (guarded on the list as it was read), never a delete of a
 * row: the entity outlives every asset it owns. That is why an asset cannot
 * leave `config/entities.json` the way it leaves the seven per-asset registers,
 * and why a delete had to be taught this op rather than given one more file to
 * clear through `ADDABLE_CONTAINERS` (bead `ro-xzxg`).
 *
 * It is the half of {@link entityMoveOps} that a DELETE needs on its own: an
 * asset that is going away is moving to nobody, and the caller wants the one op
 * rather than a list it has to unpack.
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
 * MOVING ONE ASSET BETWEEN ENTITIES, as the ops that do it.
 *
 * Up to two sets in ONE changeset: off the row that has it, onto the row the
 * operator picked. Two ops rather than one because the edge is stored on the
 * entity — which is the whole design (`config/entities.README.md`) — and one
 * changeset rather than two because an asset that left one entity and never
 * reached the other is a state no operator asked for.
 *
 * Each set guards on the list it was rendered from, so a move made against a
 * stale page is refused rather than silently dropping whatever somebody else
 * added. A row that has never owned anything carries no `assets` key at all, so
 * its first asset is an `expectAbsent` set — the same first-write permission a
 * data source's first mapping uses, licensed at exactly one place: a declared
 * OPTIONAL field of a row that already exists.
 *
 * `toSlug` of `null` is *not declared*: the asset comes off its entity's list
 * and goes onto nobody's. Picking the entity that already owns it writes
 * nothing, which is what makes an unchanged Save a no-op rather than a
 * pointless commit.
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
  // The way OFF is one op and one op only, so a move and a delete cannot come
  // to two different ideas of what leaving an entity's list looks like.
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
