import { useState } from "react";
import { Coins, Lock, Pause, type LucideIcon } from "lucide-react";
import { SectionLabel } from "@/components/surface/SectionLabel";
import type { BoardProject } from "@/lib/task-board-read";
import type { HeldBackReason, HeldBackTask } from "@/lib/task-ranking";
import { heldBackLine, plural } from "./next-read";
import { LIST_ROWS, Rows, ShowAll, SiteMark, TaskTitleLink, rowClass } from "./parts";

/** The element id the brief's last line scrolls to. */
export const NOT_NOW_ID = "tasks-not-now";

const REASON_ICON: Readonly<Record<HeldBackReason["kind"], LucideIcon>> = {
  blocked: Lock,
  parked: Pause,
  "below-cost": Coins,
};

/**
 * Every open task the ranking holds back, each with its one reason: it waits
 * on another task, it is parked, or what it is expected to make is under what
 * reviewing it costs. A task held back is still on All tasks; this list says
 * why it is not next.
 */
export function NotNow({ rows, projects }: {
  rows: readonly HeldBackTask[];
  projects: ReadonlyMap<string, BoardProject>;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, LIST_ROWS);
  return (
    <section id={NOT_NOW_ID} tabIndex={-1} className="flex scroll-mt-4 flex-col gap-2 outline-none" data-not-now="">
      <SectionLabel
        title="Not now, and why"
        caption={rows.length === 1 ? "1 open task is held back · for one reason" : `${plural(rows.length, "open task", "open tasks")} are held back · each for one reason`}
      />
      <Rows>
        {shown.map(({ task, reason }) => {
          const Icon = REASON_ICON[reason.kind];
          return (
            <li key={task.id} className={rowClass} data-not-now-row={task.id} data-not-now-reason={reason.kind}>
              <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <SiteMark site={task.project} name={projects.get(task.project)?.name ?? task.project} className="mt-0.5" />
                <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
                  <TaskTitleLink task={task} className="text-sm font-medium" />
                  <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{heldBackLine(reason)}</span>
                </div>
              </div>
            </li>
          );
        })}
      </Rows>
      {shown.length < rows.length ? <ShowAll count={rows.length} onShow={() => setAll(true)} marks={{ "data-not-now-show-all": "" }} /> : null}
    </section>
  );
}
