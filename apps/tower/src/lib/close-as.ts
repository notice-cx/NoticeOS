import { TASK_RESOLUTION_LABELS, type TaskResolution } from "@noticeos/contract/task-resolution";

/** The words a dismissal leaves as its close reason: the task client's own,
 * with the person's note after them when they gave one. */
const DISMISSED = "Dismissed";

/** The reason a close where nothing shipped carries: the person's note as
 * they wrote it, else the resolution's words (for a duplicate, with the other
 * task's id). */
export function closeAsReason({ resolution, note, duplicateOf }: {
  resolution: Exclude<TaskResolution, "done">;
  note?: string;
  duplicateOf?: string;
}): string {
  const words = note?.trim() ?? "";
  if (words !== "") return words;
  const label = TASK_RESOLUTION_LABELS[resolution];
  return duplicateOf === undefined ? label : `${label} of ${duplicateOf}`;
}

/** What a closed task's reason adds under "Closed as …": the note its closer
 * wrote, or null when the reason only repeats the resolution's words or a
 * dismissal's. A done close's reason is its evidence and is always shown. */
export function closeNote(reason: string | null | undefined, resolution: TaskResolution, duplicateOf: string | null): string | null {
  const text = reason?.trim() ?? "";
  if (text === "") return null;
  if (resolution === "done") return text;
  if (text === DISMISSED) return null;
  if (text.startsWith(`${DISMISSED}: `)) return text.slice(DISMISSED.length + 2).trim() || null;
  return text === closeAsReason({ resolution, ...(duplicateOf === null ? {} : { duplicateOf }) }) ? null : text;
}
