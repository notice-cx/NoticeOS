// WHICH PROJECT'S TASK DATABASE THE SERVER DOES NOT HOLD (bead `ro-eb7z`).
//
// Since bead `ro-237o` the runner reconciles each project's declared `database`
// in `config/beads.json` against `SHOW DATABASES` once an hour, files one
// operator task per project that disagrees, and closes it on the first pass
// where the two agree again. That answered "does anybody find out"; it did not
// answer "does the operator find out WHERE HE TYPED THE VALUE".
// `/settings#task-hub` rendered the declared name with nothing beside it, so the
// first news of a wrong one arrived in the inbox from a scheduled job — a slower
// loop than a mark on the field itself, on the one surface where the fix is a
// single edit away.
//
// WHERE THIS READS IT FROM, AND WHY IT IS NOT A PROBE. `GET /api/settings` is a
// PURE builder over config with no store read at all, precisely so the page an
// operator opens to fix things cannot blank on an empty or unreachable store —
// and asking the server what it holds belongs to the runner, the only process
// that can reach it. So the Tower reads THE TASK THAT WAS ALREADY FILED: it is
// in the store, it is already on `GET /api/work`, and it was written by the one
// thing that actually asked. The Settings page joins the two in the browser and
// the settings payload does not change at all.
//
// IT ONLY EVER SAYS "THIS ONE IS WRONG". A project with no filed task is drawn
// with nothing rather than with an all-clear, deliberately: `/api/work` carries
// a bounded head of each list, so a task can exist and not travel. An unmarked
// row therefore claims only "nothing here says otherwise", which is true.

import type { WorkProject } from "./work";

/**
 * The project a filed task is about, or null when it is some other task.
 *
 * The runner titles it `Point <asset>'s task database at one the hub holds`
 * (`taskMapTitle` in `scripts/runner/task-map.mjs`). This matches the distinctive opening
 * rather than the whole line: the asset id and the words around it are what
 * identify the task, while the tail is prose somebody may reword.
 * `scripts/os-up.test.mjs` pins that prefix from the writing side, so the two
 * cannot drift apart in silence.
 */
export function driftingAssetOf(title: string): string | null {
  const match = /^Point (\S+)'s task database at one\b/.exec(title.trim());
  return match?.[1] ?? null;
}

/**
 * Every project the OS currently has an open task about, or null when nothing
 * could be read.
 *
 * NULL AND EMPTY ARE DIFFERENT, and the difference decides whether the column
 * is drawn at all. An empty set means the board answered and named nobody; null
 * means nothing answered — a first-run install, a stopped runner, a repo that
 * could not be opened. Drawing "all clear" out of the second would be inventing
 * a verdict from silence, which is the failure this whole reconciliation exists
 * to prevent.
 *
 * Closed tasks are deliberately not read: the runner closes its own the moment
 * the two agree, so a closed one is a finished episode, and reading it would
 * keep marking a row that has been right for a week.
 */
export function driftingTaskDatabases(
  projects: readonly WorkProject[] | undefined,
): Set<string> | null {
  if (projects === undefined) return null;
  const readable = projects.filter((project) => project.ok);
  if (readable.length === 0) return null;
  const drifting = new Set<string>();
  for (const project of readable) {
    // Every open list, because which one a task lands in turns on its priority,
    // its blockers and whether anyone claimed it — none of which this question
    // depends on. `recentlyClosed` is the one list left out, for the reason
    // above.
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
 * WHETHER THE TASK SERVER ANSWERED THE LAST READ (bead `ro-ujb9.208`): the
 * reads' own errors, each once, when EVERY project the snapshot names failed;
 * otherwise null.
 *
 * `/settings#task-hub` ends with the server's address, and an address alone
 * reads the same whether the server is up or down — while the Found column,
 * which needs a readable project, silently went away. One project read
 * through the server means it answered; none, with every one failing, is the
 * state to say out loud, beside the address. No snapshot at all is not a
 * verdict either way, so it is null too — the same null-is-not-empty rule as
 * `driftingTaskDatabases` above.
 */
export function taskServerFailure(
  projects: readonly WorkProject[] | undefined,
): { errors: string[] } | null {
  if (projects === undefined || projects.length === 0) return null;
  if (projects.some((project) => project.ok)) return null;
  const errors = [...new Set(projects.map((project) => (project.error ?? "").trim()).filter((error) => error !== ""))];
  return { errors };
}
