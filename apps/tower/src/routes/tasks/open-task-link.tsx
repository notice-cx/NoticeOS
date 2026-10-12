import { Link, useLocation } from "react-router-dom";
import { pillControlClass } from "@/components/ui/pill";
import { useTasksLive } from "@/hooks/useTasks";
import { taskPath } from "@/lib/task-path";
import { cn } from "@/lib/utils";

/** Every row opens at its own task page; a row you cannot open is a dead end.
 * Drawn as a button-sized target rather than a word in a sentence, because it
 * sits in a row of verbs and a thumb has to be able to hit it. */
export function OpenTaskLink({ id, project }: { id: string; project: string }) {
  const { pathname, search } = useLocation();
  const { projectSelection } = useTasksLive();
  return (
    <Link
      to={taskPath(id, projectSelection ? project : undefined)}
      state={{ returnTo: `${pathname}${search}` }}
      className={cn(
        "inline-flex h-8 items-center rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
        pillControlClass,
      )}
      data-task-open={id}
    >
      Open task
    </Link>
  );
}
