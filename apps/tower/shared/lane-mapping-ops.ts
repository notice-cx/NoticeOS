// The operations an asset's data-source mapping is written with, shared by the
// asset's Data sources tab and the connect panel's Start collecting so both
// send the same pointer and guard.

import { collectionOps, configRegister } from "./config-registers";
import type { FileJsonDeleteOp, FileJsonSetOp, JsonValue } from "./changeset";

/** The `asset-lane` register — one asset's data-source entries, keyed by lane. */
export const LANE_REGISTER = configRegister("asset-lane");

/**
 * The op one field of one lane cell writes. Built from the declaration, so the
 * pointer the browser sends is the pointer the write lane licenses.
 *
 * `held` is what the file holds at that pointer now, and `null` means the key
 * is absent (every mapping field before its first save). An absent key and an
 * empty string are different facts, so a value goes out as `expect` and an
 * absent key as `expectAbsent`.
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
  // Narrowed rather than cast, so a shape change fails loudly.
  if (op.kind !== "file-json-set") throw new Error(`${field} did not build a set op`);
  if (held !== null) return op;
  const { expect: _rendered, ...rest } = op;
  return { ...rest, expectAbsent: true };
}

/**
 * The op that takes one mapping field back off: the inverse of the first write
 * above. `held` is the guard, so a removal after somebody else re-mapped the
 * asset is refused.
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
  // Narrowed rather than cast, so a shape change fails loudly.
  if (op.kind !== "file-json-delete") throw new Error(`${field} did not build a delete op`);
  return op;
}
