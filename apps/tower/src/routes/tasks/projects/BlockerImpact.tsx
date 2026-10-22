import { useMemo } from "react";
import { taskActorLabel } from "@shared/tasks";
import { ListPanel, ListRow } from "@/components/surface/ListPanel";
import { blockerImpact } from "@/lib/blocker-impact";
import { formatInt } from "@/lib/format";
import { inboxAsk, type BoardProject } from "@/lib/task-board-read";
import { taskStateWord } from "@/lib/task-board-viz";
import { taskPath } from "@/lib/task-path";

export function BlockerImpact({ projects }: { projects: readonly BoardProject[] }) {
  const { rows, partial } = useMemo(() => blockerImpact(projects), [projects]);
  return (
    <div className="flex min-w-0 flex-col gap-2" data-blocker-impact data-blocker-partial={partial}>
      <ListPanel title="Holding up work" count={partial ? "Known work · lower bounds" : undefined}
        empty={partial ? "No blockers found in the available dependencies." : "No unfinished tasks hold up other work."}>
        {rows.map(({ project, task, downstream, couldReady }) => (
          <ListRow key={JSON.stringify([project.asset, task.id])} title={task.title}
            to={taskPath(task.id, project.asset)} captionWrap
            caption={`${project.name} · ${taskStateWord({ ...task, status: task.workStatus ?? task.status }, 0, inboxAsk(task))} · ${task.assignee ? taskActorLabel(task.assignee, task.actors) : "Unassigned"}`}
            value={<span className="grid gap-0.5 text-xs font-normal">
              <span><b className="tabular-nums">{partial ? "≥" : ""}{formatInt(downstream)}</b> downstream</span>
              <span><b className="tabular-nums">{couldReady === null ? "—" : formatInt(couldReady)}</b> could become ready</span>
            </span>}
            marks={{ "data-blocker-task": task.id, "data-blocker-project": project.asset }} />
        ))}
      </ListPanel>
      <p className="m-0 text-xs text-muted-foreground">
        Distinct unfinished tasks downstream, including parked work. Could become ready counts only work with no other blocker or human hold.
        {partial ? " Available reads may omit tasks or dependencies; counts are known lower bounds. A dash means readiness is unknown." : null}
      </p>
    </div>
  );
}
