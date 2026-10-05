import { PageHeader } from "@/components/PageHeader";
import { NewTaskButton, TasksBoard } from "@/routes/tasks/TasksBoard";

/**
 * `/tasks` — the portfolio's task index (D19, bead `ro-l1ed.2`).
 * `/work` is its older address and redirects here.
 *
 * The page is its header and the board: everything below the header is
 * `TasksBoard` (`routes/tasks/TasksBoard.tsx`), which an asset page's **Tasks**
 * tab renders with its own project pinned (`ro-l1ed.5`). One rendering of the
 * task hub, two surfaces, differing by one prop — and the task's own page draws
 * status and priority from the same `routes/tasks/task-face.tsx`, so a task
 * looks the same on all three.
 *
 * The board carries its own age badge, beside the summary line that says what it
 * is showing: it is now rendered under two different headers, and the age
 * belongs to the rows rather than to whichever chrome happens to be above them.
 * **New task** stays here, because on this page it is the page's one primary
 * action and D17 puts that in the page header; a tab panel has no header of its
 * own, so there the board draws the same button itself.
 */
export function TasksRoute() {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 md:p-6">
      {/* No subtitle (bead `ro-ujb9.96.6.11`): the board under the title is
          the description — its first panel is literally "Waiting on you". */}
      <PageHeader title="Tasks" actions={<NewTaskButton />} />
      <TasksBoard />
    </div>
  );
}

export default TasksRoute;
