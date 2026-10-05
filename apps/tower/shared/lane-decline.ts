// "NOT USING" — ONE PRESS, THEN A REASON THE OPERATOR PICKS (beads
// `ro-ujb9.96.7.13` and `ro-ujb9.96.7.18`; operator answer A, 2026-09-23).
//
// A declined data source is the register's `skipped` posture, and
// config/integrations.README.md requires every one to carry its reason in
// `note` — "the system may decide not to do something; it may not decide not
// to mention it" (AGENTS.md). The operator decided HOW that reason arrives: one
// of three chips, or a line of their own. Never typed as a rule, never a
// prefix to learn, never a reason the product picked for them.
//
// ONE VOCABULARY AND ONE WRITE, for the two surfaces that decline a source:
// the asset's Data sources row (`routes/asset-detail/LaneConfig.tsx`
// `LanePostureAction`) and an unticked row in the connect panel
// (`components/SitePicker.tsx`, through `shared/site-discovery.ts`
// `startPlan`, bead `ro-ujb9.96.7.18`). Both write the `asset-lane` register
// through `laneFieldOp` — the same pointer, guard and `PUT /api/config` with
// its `config_changes` audit row — so a source declined in the panel is
// exactly the source declined on its row, and the collectors skip it the same
// way (`laneDeclined`, workers/ingest/src/lane-mapping.ts).

import type { FileJsonDeleteOp, FileJsonSetOp, JsonValue } from "./changeset";
import { laneFieldOp, laneFieldUnsetOp } from "./lane-mapping-ops";

/** The three reasons the operator chose to offer, in their words. */
export const DECLINE_REASONS = [
  { id: "product", label: "Don't use this product" },
  { id: "replaced", label: "Replaced by another tool" },
  { id: "not-relevant", label: "Not relevant for this site" },
] as const;

export type DeclineReasonId = (typeof DECLINE_REASONS)[number]["id"];

/**
 * THE MACHINE SHAPE OF A DECLINE REASON, written by the product and never by
 * the operator. The README's own validation reads a skipped cell's note with
 * `/reason/i`, and the prefix is also what tells a leftover decline reason on
 * a lane that is in use again apart from a note saying what blocks it.
 */
export const DECLINE_NOTE_PREFIX = "REASON: ";

/** The register's `note` holds at most 90 characters (`asset-lane` maxLength,
 * bead `ro-ujb9.96.6.4`); the prefix spends eight of them. */
export const NOTE_MAX_LENGTH = 90;
export const OWN_REASON_MAX_LENGTH = NOTE_MAX_LENGTH - DECLINE_NOTE_PREFIX.length;

/** The note a decline stores for what the operator picked or wrote. */
export function declineNote(reason: string): string {
  return `${DECLINE_NOTE_PREFIX}${reason.trim().replace(/\s+/g, " ")}`.slice(0, NOTE_MAX_LENGTH);
}

/** The operator's own words back out of a stored note: the prefix is the
 * product's, so it is never shown. Null when the note is no decline reason. */
export function declineReason(note: string | null | undefined): string | null {
  if (typeof note !== "string") return null;
  const match = /^\s*reason:\s*/i.exec(note);
  if (!match) return null;
  const reason = note.slice(match[0].length).trim();
  return reason === "" ? null : reason;
}

/** One lane cell as the two surfaces hold it before the press: what the file
 * says NOW, which is each op's guard. `note` is null when the cell has no
 * note key at all — a first write, guarded as one (`laneFieldOp`). */
export interface HeldPosture {
  status: string;
  note: string | null;
}

/**
 * The write "Not using" makes: the reason and the posture in ONE changeset,
 * each guarded by what the file holds. A note already saying exactly this is
 * not written again. `since` moves with the posture by itself (the register's
 * `stamps`, bead `ro-t7fz`).
 */
export function declineOps(asset: string, laneId: string, held: HeldPosture, reason: string): FileJsonSetOp[] {
  const note = declineNote(reason);
  return [
    ...(held.note === note ? [] : [laneFieldOp(asset, laneId, "note", held.note, note)]),
    ...(held.status === "skipped" ? [] : [laneFieldOp(asset, laneId, "status", held.status, "skipped")]),
  ];
}

/**
 * The way back from a decline, as its Undo writes it: the exact inverse. The
 * posture always goes back. The note goes back to what it was — and a cell
 * that had NO note (a new site's source, bead `ro-ujb9.96.7.22`) has the key
 * taken off again, guarded by the reason just written. Only a legacy cell
 * holding a blank note keeps the reason as its history, because the register
 * refuses a blank note; `declineReason` is what keeps that from reading as a
 * blocker once the source is in use again.
 */
export function undeclineOps(asset: string, laneId: string, held: HeldPosture, reason: string): (FileJsonSetOp | FileJsonDeleteOp)[] {
  const note = declineNote(reason);
  const noteBack = held.note === note || (held.note !== null && held.note.trim() === "")
    ? []
    : held.note === null
      ? [laneFieldUnsetOp(asset, laneId, "note", note)]
      : [laneFieldOp(asset, laneId, "note", note, held.note)];
  return [...noteBack, laneFieldOp(asset, laneId, "status", "skipped", held.status as JsonValue)];
}

/** "Use again": one press puts a declined source back to be set up. The
 * reason stays as the cell's history (see `undeclineOps`). */
export function resumeOps(asset: string, laneId: string, heldStatus: string): FileJsonSetOp[] {
  return [laneFieldOp(asset, laneId, "status", heldStatus, "needs-setup")];
}
