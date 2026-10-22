import { TASK_BLOCKING_DEPENDENCIES } from "@noticeos/contract/task-gate";
import { isGate, type BoardProject, type BoardTask } from "./task-board-read";

export interface BlockerImpactRow {
  project: BoardProject;
  task: BoardTask;
  downstream: number;
  /** Unknown on saved samples: they omit labels needed to rule out human holds. */
  couldReady: number | null;
}

const unfinished = (task: BoardTask) => task.status !== "closed";
const work = (task: BoardTask) => task.issueType !== "epic" && !isGate(task);
const blocking = (edge: { type: string }) => TASK_BLOCKING_DEPENDENCIES.includes(edge.type);

/** Dependencies point from dependent to blocker, and ids are local to a project.
 * Closed work stops a chain; parked work is unfinished but cannot become ready.
 * Every traversal visits each node once, including in cycles and diamonds. */
export function blockerImpact(projects: readonly BoardProject[]) {
  const rows: BlockerImpactRow[] = [];
  let partial = projects.length === 0;
  for (const project of projects) {
    const current = project.source === "live" && project.laneError === null;
    if (!current) partial = true;
    const byId = new Map(project.tasks.map(task => [task.id, task]));
    const dependents = new Map<string, Set<string>>();
    const releases = new Map<string, number>();
    for (const task of byId.values()) {
      if (!unfinished(task) || task.issueType === "epic") continue;
      if (task.dependencies === undefined) partial = true;
      const unresolved = new Set<string>();
      for (const edge of task.dependencies ?? []) {
        if (!blocking(edge)) continue;
        const target = byId.get(edge.id);
        if ((target?.status ?? edge.status) === "closed") continue;
        unresolved.add(edge.id);
        if (!target) {
          partial = true;
          continue;
        }
        const children = dependents.get(edge.id) ?? new Set<string>();
        children.add(task.id);
        dependents.set(edge.id, children);
      }
      // Stored "open" alone is not evidence of readiness. An unknown target
      // remains a blocker; an unanswered human task or choice remains a hold.
      if (current && work(task) && !task.ready && (task.status === "open" || task.status === "blocked")
        && !task.deferUntil
        && !(task.labels.includes("human") && task.choice == null)
        && !(task.choices != null && task.choice == null) && unresolved.size === 1) {
        const [id] = unresolved;
        if (id !== undefined && id !== task.id && byId.has(id)) releases.set(id, (releases.get(id) ?? 0) + 1);
      }
    }
    for (const task of byId.values()) {
      if (!unfinished(task) || task.issueType === "epic" || !dependents.has(task.id)) continue;
      const seen = new Set([task.id]);
      const pending = [task.id];
      let downstream = 0;
      while (pending.length > 0) {
        const id = pending.pop()!;
        for (const child of dependents.get(id) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          pending.push(child);
          if (work(byId.get(child)!)) downstream += 1;
        }
      }
      if (downstream > 0) rows.push({ project, task, downstream, couldReady: current ? releases.get(task.id) ?? 0 : null });
    }
  }
  rows.sort((a, b) => b.downstream - a.downstream || (b.couldReady ?? -1) - (a.couldReady ?? -1)
    || a.project.asset.localeCompare(b.project.asset) || a.task.id.localeCompare(b.task.id));
  return { rows, partial };
}
