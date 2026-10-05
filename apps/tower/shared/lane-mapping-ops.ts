// THE OPERATIONS AN ASSET'S DATA SOURCE MAPPING IS WRITTEN WITH — one copy,
// shared by the two surfaces that write it (bead `ro-ujb9.96.7.2`): the asset's
// Data sources tab (`routes/asset-detail/LaneConfig.tsx`, one field at a time)
// and the connect panel's Start collecting (`shared/site-discovery.ts`, every
// confirmed site in one press). Moved here whole from LaneConfig so the two
// cannot drift: the same register, the same pointer, the same guard, and the
// same `PUT /api/config` write with its `config_changes` audit row.

import { collectionOps, configRegister } from "./config-registers";
import type { FileJsonDeleteOp, FileJsonSetOp, JsonValue } from "./changeset";

/** The `asset-lane` register — one asset's data-source entries, keyed by lane. */
export const LANE_REGISTER = configRegister("asset-lane");

/**
 * The op one field of one lane cell writes. Built from the declaration, so the
 * pointer the browser sends is the pointer the write lane licenses.
 *
 * `held` is what the file holds at that pointer RIGHT NOW, and `null` means the
 * key is not there at all — which is every mapping field before its first save,
 * because each one is written only when an operator maps the asset. An absent
 * key and an empty string are DIFFERENT FACTS (bead `ro-j71v`), so the guard
 * says which one it read: a value goes out as `expect`, an absent key as
 * `expectAbsent`. Sending `""` for an absent key is what made the first mapping
 * saved on any asset come back as "changed elsewhere".
 */
export function laneFieldOp(
  asset: string,
  laneId: string,
  field: string,
  held: JsonValue | null,
  value: JsonValue,
): FileJsonSetOp {
  const { op } = collectionOps(LANE_REGISTER, { asset }, {
    kind: "edit",
    token: laneId,
    field,
    // A placeholder for the absent case, replaced below: the register builds the
    // POINTER, and the guard is this function's own answer.
    expect: held ?? "",
    value,
  });
  // An `edit` change is a set by construction; the narrowing is here rather
  // than a cast so a future shape change fails loudly instead of silently.
  if (op.kind !== "file-json-set") throw new Error(`${field} did not build a set op`);
  if (held !== null) return op;
  const { expect: _rendered, ...rest } = op;
  return { ...rest, expectAbsent: true };
}

/**
 * The op that takes one mapping field back OFF (bead `ro-pkpz`) — the exact
 * inverse of the first write above, built from the same declaration.
 *
 * `held` is what the file holds, and it is the guard: a removal that ran after
 * somebody else re-mapped the asset is refused rather than quietly taking away
 * their value.
 */
export function laneFieldUnsetOp(
  asset: string,
  laneId: string,
  field: string,
  held: JsonValue,
): FileJsonDeleteOp {
  const { op } = collectionOps(LANE_REGISTER, { asset }, {
    kind: "unset",
    token: laneId,
    field,
    expect: held,
  });
  // Narrowed rather than cast, the same way `laneFieldOp` narrows its set: a
  // future shape change fails loudly instead of silently.
  if (op.kind !== "file-json-delete") throw new Error(`${field} did not build a delete op`);
  return op;
}
