import { claimedModel, taskActorLabel } from "@shared/tasks";
import { Meter } from "@/components/Meter";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatInt } from "@/lib/format";
import type { BoardTask } from "@/lib/task-board-read";
import type { EpicTaskGroup } from "@/lib/task-board-viz";
import { cn } from "@/lib/utils";
import { TaskRow } from "./task-row";

/** An epic's all-time progress: closed of total, as a bar with its figure. */
export function EpicProgress({ closed, total, className }: { closed: number; total: number; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)} data-epic-progress={`${closed}/${total}`}>
      <Meter value={closed} max={total} ariaLabel={`${closed} of ${total} children closed`} className="w-24 shrink-0" />
      <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        {formatInt(closed)} of {formatInt(total)} closed
      </span>
    </span>
  );
}

/**
 * Everything an epic holds, grouped by where each task stands in the board's
 * words, each row opening its own page. `missing` names the tasks the epic
 * holds that this read does not list, and why, so a short list never reads as
 * the whole epic.
 */
export function EpicTaskList({
  groups,
  missing,
  graphHref,
  taskHref,
  className,
}: {
  groups: readonly EpicTaskGroup[];
  missing: string | null;
  /** The board's Epic graph with this epic chosen, when the board draws one. */
  graphHref: string | null;
  taskHref: (id: string) => string;
  className?: string;
}) {
  const listed = groups.reduce((sum, group) => sum + group.tasks.length, 0);
  return (
    <Card className={className} data-epic-tasks="">
      <CardHeader className="pb-2">
        <SectionLabel
          title="Tasks"
          caption={listed > 0 ? formatInt(listed) : undefined}
          action={graphHref ? { label: "Epic graph →", to: graphHref } : undefined}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {groups.map((group) => (
          <section key={group.word} aria-label={group.word} data-epic-group={group.word} className="flex min-w-0 flex-col gap-1">
            <h3 className="m-0 flex items-baseline gap-2 text-xs font-medium text-foreground">
              {group.word}
              <span className="tabular-nums text-muted-foreground">{formatInt(group.tasks.length)}</span>
            </h3>
            <ul className="-mx-2 flex flex-col">
              {group.tasks.map((task) => (
                <EpicTaskRow key={task.id} task={task} href={taskHref(task.id)} />
              ))}
            </ul>
          </section>
        ))}
        {missing ? (
          <p className="m-0 text-xs text-muted-foreground" data-epic-missing="">{missing}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function EpicTaskRow({ task, href }: { task: BoardTask; href: string }) {
  const holder = task.assignee ? taskActorLabel(task.assignee, task.actors) : null;
  const model = claimedModel({ metadata: (task as BoardTask & { metadata?: Record<string, unknown> | null }).metadata ?? null });
  return (
    <TaskRow
      task={{ id: task.id, title: task.title, status: task.status, priority: task.priority, holder: holder ? { name: holder, model } : null }}
      href={href}
      marks={{ "data-epic-task": task.id }}
    />
  );
}
