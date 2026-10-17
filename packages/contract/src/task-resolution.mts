// How a task's close ended: done, or one of the closes where nothing shipped.
// The close operation records it in the task's metadata as
// `noticeos_resolution` (and `noticeos_duplicate_of` for a duplicate) in the
// same write as the closer (task-metadata.mts), so it describes that close
// only. Every reader goes through `readTaskResolution`, which answers done for
// a task that records none or records an earlier close's, so every close made
// before resolutions existed reads as it always did.
//
// Authored TypeScript: `pnpm generate` writes the `.mjs` and `.d.mts`
// beside it.

import { recordsClose, TASK_METADATA } from "./task-metadata.mjs";

/** Done first: the default, and the only one that counts as work shipped. */
export const TASK_RESOLUTIONS = Object.freeze(["done", "wont-do", "duplicate", "cant-reproduce", "already-handled"] as const);
export type TaskResolution = (typeof TASK_RESOLUTIONS)[number];

/** Each resolution's words on screen, quoted exactly by the docs. */
export const TASK_RESOLUTION_LABELS: Readonly<Record<TaskResolution, string>> = Object.freeze({
  done: "Done",
  "wont-do": "Won't do",
  duplicate: "Duplicate",
  "cant-reproduce": "Can't reproduce",
  "already-handled": "Already handled",
});

export function isTaskResolution(value: unknown): value is TaskResolution {
  return typeof value === "string" && (TASK_RESOLUTIONS as readonly string[]).includes(value);
}

/** A task id: the task tools' prefix, hash and child grammar. */
const TASK_ID = /^[a-z0-9]+-{1,2}[a-z0-9]+(?:\.[0-9]+)*$/iu;

export interface TaskCloseResolution {
  readonly resolution: TaskResolution;
  /** The task a duplicate names; null for every other resolution. */
  readonly duplicateOf: string | null;
}

const DONE: TaskCloseResolution = Object.freeze({ resolution: "done", duplicateOf: null });

/** How the task's close at `closedAt` ended, from its metadata: what the close
 * operation recorded for that close, else done. A duplicate whose other task
 * cannot be read still reads as a duplicate, naming none. */
export function readTaskResolution(metadata: unknown, closedAt: unknown): TaskCloseResolution {
  if (!recordsClose(metadata, closedAt)) return DONE;
  const record = metadata as Record<string, unknown>;
  const resolution = record[TASK_METADATA.resolution.name];
  if (!isTaskResolution(resolution) || resolution === "done") return DONE;
  const other = record[TASK_METADATA.duplicateOf.name];
  const duplicateOf = resolution === "duplicate" && typeof other === "string" && TASK_ID.test(other) ? other : null;
  return Object.freeze({ resolution, duplicateOf });
}
