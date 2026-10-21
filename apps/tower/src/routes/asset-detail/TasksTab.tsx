import type { AssetDetailFor } from "@shared/asset-detail-views";
import { TasksBoard } from "@/routes/tasks/TasksBoard";
import { NextTab } from "@/routes/tasks/next/NextTab";

/**
 * The Tasks tab: what to decide next for this site, then the Tasks board
 * pinned to this site's project. The decisions are the Next tab's, drawn
 * compact, and the board is the one `/tasks/all` renders, so a claim, a close
 * or an answered ask behaves here exactly as it does on the index. The board
 * marks its own first screen, because only the board knows where its answer
 * ends.
 */
export function TasksTab({ data }: { data: AssetDetailFor<"tasks"> }) {
  return (
    <div id="tasks" className="flex scroll-mt-4 flex-col gap-6">
      <NextTab scope={data.asset.id} compact />
      <TasksBoard project={data.asset.id} newTask />
    </div>
  );
}
