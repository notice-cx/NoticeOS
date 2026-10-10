import type { AssetDetailFor } from "@shared/asset-detail-views";
import { TasksBoard } from "@/routes/tasks/TasksBoard";

/**
 * THE TASKS TAB: the Tasks index, pinned to this asset's project (`ro-l1ed.5`).
 *
 * The SAME component `/tasks` renders — one board, two surfaces — so a claim, a
 * close or an answered ask behaves here exactly as it does on the index, and
 * neither can drift from the other.
 *
 * DOC 21 REACHES THIS TAB THROUGH THAT COMPONENT, not around it (`ro-78qo.5`).
 * The board is being rebuilt to the vocabulary under `ro-78qo.12` — a KPI strip,
 * a Waiting-on-you `ListPanel` at five rows, then one table paged 25 at a time
 * with rows that expand in place — and a scoped board comes out of that rebuild
 * doc-21 shaped. Forking a smaller read-only copy for this tab would have cost
 * the operator every verb on it and given the desk a second answer to "what is
 * open on this asset", which is exactly the drift the one-board rule exists to
 * prevent. Confirmed with that bead's owner on 2026-09-05 before this landed.
 *
 * So this tab adds nothing at all. It declared the `Hero` mark for a while,
 * because a scoped board emitted none — but a wrapper here can only span the
 * WHOLE board, so the audit measured the bottom of the 25-row table and reported
 * the first screen 973px over. Only the board knows where its answer ends, so
 * the board marks it (bead `ro-78qo.32`). The `About` is the board's for the
 * same reason, and doc 14 allows a screen exactly one.
 */
export function TasksTab({ data }: { data: AssetDetailFor<"tasks"> }) {
  return (
    <div id="tasks" className="scroll-mt-4">
      <TasksBoard project={data.asset.id} newTask />
    </div>
  );
}
