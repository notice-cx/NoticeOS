import { useId } from "react";
import { ChevronRight, CircleHelp } from "lucide-react";
import { Link } from "react-router-dom";
import { AgentMark } from "@/components/AgentMark";
import { cn } from "@/lib/utils";
import { PriorityMark, TaskStatusGlyph, priorityFace, statusFace } from "./task-face";

/** What one row of tasks on a task page draws. A null status is a task the
 * read names without its state (an edge `bd show` did not expand). */
export interface TaskRowFacts {
  id: string;
  title: string | null;
  status: string | null;
  project?: string;
  projectName?: string;
  priority?: number | null;
  /** Who holds it and the model they named. */
  holder?: { name: string; model: string | null } | null;
}

/** A row's marks in words, its description for a screen reader: the state,
 * who holds it, the priority. */
export function taskRowSaid(task: TaskRowFacts): string {
  return [
    task.status === null ? "State unknown" : statusFace(task.status).label,
    task.holder ? `held by ${task.holder.name}${task.holder.model ? ` · ${task.holder.model}` : ""}` : null,
    task.priority === null || task.priority === undefined ? null : `${priorityFace(task.priority).band} priority`,
  ].filter(Boolean).join(", ");
}

/**
 * One task as one target, the way the board's rows read: the status glyph,
 * the id and title, who holds it and the priority mark. The whole row is the
 * link, so a press anywhere on it, or Enter once it has focus, opens the task;
 * its name is the id and the title, and the state and holder are its
 * description.
 */
export function TaskRow({
  task,
  href,
  marks,
  className,
}: {
  task: TaskRowFacts;
  href: string;
  /** `data-*` attributes for the row, e.g. `{ "data-epic-task": id }`. */
  marks?: Record<`data-${string}`, string>;
  className?: string;
}) {
  const ids = useId();
  const name = `${ids}-id ${ids}-title${task.projectName ? ` ${ids}-project` : ""}`;
  const said = taskRowSaid(task);
  return (
    <li className={cn("min-w-0 list-none", className)} {...marks}>
      <Link
        to={href}
        aria-labelledby={task.title ? name : `${ids}-id`}
        aria-describedby={`${ids}-said`}
        data-task-row-link={task.id}
        className={cn(
          "group flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none",
          "hover:bg-muted/60 active:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring",
          "motion-safe:transition-colors motion-safe:active:scale-[0.995]",
        )}
      >
        <span id={`${ids}-said`} hidden>{said}</span>
        <span className="flex shrink-0">
          {task.status === null ? (
            <CircleHelp role="img" className="size-3.5 shrink-0 text-muted-foreground/60" aria-label="State — unknown" />
          ) : (
            <TaskStatusGlyph status={task.status} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <span id={`${ids}-id`} className="shrink-0 font-mono text-xs text-muted-foreground group-hover:text-foreground motion-safe:transition-colors">
            {task.id}
          </span>
          {task.title ? (
            <span id={`${ids}-title`} className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">
              {task.title}
            </span>
          ) : null}
          {task.projectName ? <span id={`${ids}-project`} className="text-xs text-muted-foreground">{task.projectName}</span> : null}
        </span>
        <span aria-hidden className="flex shrink-0 items-center gap-2">
          {task.holder ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground max-sm:hidden">
              <AgentMark name={task.holder.name} models={[task.holder.model]} size="small" />
              <span className="text-foreground">{task.holder.name}</span>
              {task.holder.model ? <span>· {task.holder.model}</span> : null}
            </span>
          ) : null}
          {task.priority === null || task.priority === undefined ? null : <PriorityMark priority={task.priority} hint={false} />}
        </span>
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 motion-safe:transition-[opacity,transform] motion-safe:group-hover:translate-x-0.5"
        />
      </Link>
    </li>
  );
}
