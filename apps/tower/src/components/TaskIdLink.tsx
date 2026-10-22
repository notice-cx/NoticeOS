import { Link } from "react-router-dom";
import { taskPath } from "@/lib/task-path";
import { cn } from "@/lib/utils";

export interface TaskIdLinkProps {
  /** A task id, such as `md-1w2`. */
  id: string;
  className?: string;
}

/**
 * A task named by its id, as the link to its page, in mono at the size of the
 * text around it. It carries no state: where the asset's snapshot holds the
 * task, HandoffBeadBadge draws it with its open or closed glyph instead.
 */
export function TaskIdLink({ id, className }: TaskIdLinkProps) {
  return (
    <Link
      to={taskPath(id)}
      data-task-id-link={id}
      className={cn(
        "break-all rounded-sm font-mono text-foreground underline underline-offset-4 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {id}
    </Link>
  );
}
