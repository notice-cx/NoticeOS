import { Link } from "react-router-dom";
import type { AssetDetailFor } from "@shared/asset-detail-views";
import { Button } from "@/components/ui/button";
import { useTaskService } from "@/hooks/useTaskService";
import { useWork } from "@/hooks/useWork";
import { TASKS_ROUTE } from "@/components/nav-items";
import { TASK_SOURCES_PATH } from "@shared/task-source";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The Tasks tab: this asset's open work, counted on the server, and the way
 * into its project on the Tasks board, where tasks are read, decided and
 * changed as the person signed in to Ntasks.
 */
export function TasksTab({ data }: { data: AssetDetailFor<"tasks"> }) {
  const { data: work } = useWork();
  const { data: service } = useTaskService();
  const spoke = (work?.projects ?? []).find((project) => project.asset === data.asset.id) ?? null;
  const key = service?.projects?.find((entry) => entry.asset === data.asset.id)?.project?.logicalKey ?? null;
  const board = (view?: "waiting") => {
    const query = new URLSearchParams();
    if (key !== null) query.set("project", key);
    if (view) query.set("view", view);
    return query.size === 0 ? TASKS_ROUTE : `${TASKS_ROUTE}?${query}`;
  };
  const open = spoke?.ok ? spoke.counts.open : null;
  const waiting = spoke?.ok ? (spoke.counts.waiting ?? 0) : 0;
  if (work && spoke === null) {
    return (
      <section id="tasks" aria-label="Tasks" className="flex scroll-mt-4 flex-col items-start gap-3 rounded-xl bg-card p-5 ring-1 ring-border/70" data-tasks-unwired="">
        <p className="m-0 text-sm font-medium">No task project for this asset</p>
        <Button asChild size="sm" variant="outline">
          <Link to={TASK_SOURCES_PATH}>Add a task project</Link>
        </Button>
      </section>
    );
  }
  return (
    <section id="tasks" aria-label="Tasks" className="flex scroll-mt-4 flex-col items-start gap-3 rounded-xl bg-card p-5 ring-1 ring-border/70" data-asset-tasks="">
      {open === null ? null : (
        <p className="m-0 text-sm">
          {open === 0 ? "No open tasks." : `${plural(open, "open task")}${waiting > 0 ? `, ${waiting} for you to decide` : ""}.`}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {waiting > 0 ? (
          <Button asChild size="sm">
            <Link to={board("waiting")}>Decide</Link>
          </Button>
        ) : null}
        <Button asChild size="sm" variant={waiting > 0 ? "outline" : "default"}>
          <Link to={board()}>Open in Tasks</Link>
        </Button>
      </div>
    </section>
  );
}
