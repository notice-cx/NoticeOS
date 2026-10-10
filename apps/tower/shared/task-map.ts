// Which project's task database the server does not hold. The runner checks
// each project's declared `database` against the server hourly and files an
// open task per mismatch; Settings marks the field from that task (read off
// `GET /api/work`) rather than probing, because `GET /api/settings` reads no
// store and only the runner can reach the server. It only ever says "this one
// is wrong": `/api/work` carries a bounded head of each list, so an unmarked
// row claims nothing.

import type { WorkProject } from "./work";

/**
 * The project a filed task is about, or null when it is some other task.
 *
 * The runner titles it `Point <asset>'s task database at one the hub holds`
 * (`taskMapTitle` in `scripts/runner/task-map.mjs`). This matches the distinctive opening
 * rather than the whole line: the asset id and the words around it are what
 * identify the task, while the tail is prose somebody may reword.
 * `scripts/os-up.test.mjs` pins that prefix from the writing side.
 */
export function driftingAssetOf(title: string): string | null {
  const match = /^Point (\S+)'s task database at one\b/.exec(title.trim());
  return match?.[1] ?? null;
}

/**
 * Every project the OS currently has an open task about, or null when nothing
 * could be read.
 *
 * Null and empty differ, and decide whether the column is drawn: an empty set
 * means the board answered and named nobody; null means nothing answered.
 * Closed tasks are not read: the runner closes its own once the two agree.
 */
export function driftingTaskDatabases(
  projects: readonly WorkProject[] | undefined,
): Set<string> | null {
  if (projects === undefined) return null;
  const readable = projects.filter((project) => project.ok);
  if (readable.length === 0) return null;
  const drifting = new Set<string>();
  for (const project of readable) {
    // Every open list: which one a task lands in does not matter here.
    for (const item of [
      ...project.ready,
      ...project.inProgress,
      ...project.waiting,
      ...project.deferred,
    ]) {
      const asset = driftingAssetOf(item.title);
      if (asset !== null) drifting.add(asset);
    }
  }
  return drifting;
}

/**
 * Whether the task server answered the last read: the reads' own errors, each
 * once, when every project the snapshot names failed; otherwise null. One
 * readable project means it answered; no snapshot at all is not a verdict, so
 * it is null too.
 */
export function taskServerFailure(
  projects: readonly WorkProject[] | undefined,
): { errors: string[] } | null {
  if (projects === undefined || projects.length === 0) return null;
  if (projects.some((project) => project.ok)) return null;
  const errors = [...new Set(projects.map((project) => (project.error ?? "").trim()).filter((error) => error !== ""))];
  return { errors };
}
