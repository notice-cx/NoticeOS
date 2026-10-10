import type { AssetDetailFor } from "@shared/asset-detail-views";
import { TasksBoard } from "@/routes/tasks/TasksBoard";

/**
 * The Tasks tab: the Tasks index, pinned to this asset's project. The same
 * component `/tasks` renders, so a claim, a close or an answered ask behaves
 * here exactly as it does on the index. This tab adds nothing: the board marks
 * its own first screen, because only the board knows where its answer ends.
 */
export function TasksTab({ data }: { data: AssetDetailFor<"tasks"> }) {
  return (
    <div id="tasks" className="scroll-mt-4">
      <TasksBoard project={data.asset.id} newTask />
    </div>
  );
}
