import { PageHeader } from "@/components/PageHeader";
import { NewTaskButton, TasksBoard } from "@/routes/tasks/TasksBoard";

/**
 * `/tasks`: the portfolio's task index. `/work` is its older address and
 * redirects here. The page is its header and the board: everything below the
 * header is `TasksBoard`, which an asset page's Tasks tab renders with its
 * own project pinned. New task stays here because it is the page's one
 * primary action; a tab panel has no header of its own, so there the board
 * draws the same button itself.
 */
export function TasksRoute() {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 md:p-6">
      {/* No subtitle: the board under the title is the description. */}
      <PageHeader title="Tasks" actions={<NewTaskButton />} />
      <TasksBoard />
    </div>
  );
}

export default TasksRoute;
