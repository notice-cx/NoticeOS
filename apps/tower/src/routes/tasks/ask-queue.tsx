import { taskOperationAvailable } from "@shared/tasks";
import { ListRow } from "@/components/surface/ListPanel";
import { DecisionQueue, ageLabel, ageLength } from "@/components/viz/DecisionQueue";
import { useTasksLive } from "@/hooks/useTasks";
import { askVerb, isGate, type BoardProject, type BoardTask } from "@/lib/task-board-read";
import { queueItem } from "@/lib/task-board-viz";
import { cn } from "@/lib/utils";
import { useAskActions } from "./ask-actions";
import { OpenTaskLink } from "./open-task-link";
import { askFace } from "./task-face";

/** The queue opens at five rows and discloses the rest through its own
 * expander. Nothing is sliced first: a queue that silently keeps five of nine
 * is lying about its size. */
const ASK_ROWS = 5;

export interface Ask {
  project: BoardProject;
  task: BoardTask;
}

/**
 * Waiting on you, drawn as a queue: how many wait, how old the waits are,
 * then each ask with its age as a length and its verbs on the row. A row
 * opens in place for the evidence; no row opens on arrival, because the
 * queue mounts on the snapshot and is reordered by the live read, and the
 * row that ends up first would be whichever happened to mount first.
 */
export function AskQueue({ asks, total, complete, nowMs, showProject, className }: {
  asks: readonly Ask[];
  /** The whole queue, which the snapshot's rows may undercount. */
  total: number;
  complete: boolean;
  nowMs: number;
  showProject: boolean;
  className?: string;
}) {
  const items = asks.map((ask) => queueItem(ask, nowMs));
  return (
    <DecisionQueue
      items={items}
      total={total > 0 ? total : null}
      totalNote={complete ? undefined : "partial read"}
      title="Waiting on you"
      limit={ASK_ROWS}
      empty={complete ? "Nothing is waiting on you." : "Waiting work is unknown for unread projects."}
      className={className}
    >
      {asks.map((ask, index) => (
        <AskRow key={ask.task.id} {...ask} ageDays={items[index]!.ageDays} showProject={showProject} />
      ))}
    </DecisionQueue>
  );
}

/**
 * One ask, answered on its row (`useAskActions`): a claimable `human`-labelled
 * task, or an open gate holding other work. Warn at every priority: the
 * operator being the blocker is not a failure. The verbs stay quiet until the
 * row is pointed at, so six identical buttons never outshout six asks.
 */
function AskRow({ project, task, ageDays, showProject }: Ask & { ageDays: number | null; showProject: boolean }) {
  // The verbs and the answer box are the task page's too.
  const capabilities = useTasksLive();
  const supported = taskOperationAvailable(capabilities, isGate(task) ? "resolve" : "respond");
  const { buttons, box } = useAskActions({ ask: askVerb(task), id: task.id, title: task.title, project: task.project, placement: "row",
    disabledReason: supported ? null : "Unavailable in this workspace." });
  const evidence = [task.description, task.acceptance].some((value) => (value ?? "").trim() !== "");

  return (
    <ListRow
      {...askFace(task)}
      title={task.title}
      // The project and what the row asks, never the task's id, which is on
      // the task's own page.
      caption={[showProject ? project.name : null, isGate(task) ? "needs your approval" : null].filter(Boolean).join(" · ") || null}
      value={<AskAge days={ageDays} />}
      marks={{ "data-inbox-row": task.id, "data-subject": `task:${task.id}` }}
      rowActions={project.actionable ? (
        <span className="flex flex-wrap items-center gap-2 opacity-60 transition-opacity group-hover/ask:opacity-100 group-focus-within/ask:opacity-100 max-sm:opacity-100">
          {buttons}
        </span>
      ) : undefined}
      below={project.actionable ? box : null}
      className="group/ask border-b border-border/40 px-3 py-0.5 last:border-b-0"
    >
      {evidence ? (
        <span className="grid gap-1" data-inbox-evidence>
          {task.description?.trim() ? <span className="whitespace-pre-line text-foreground">{task.description.trim()}</span> : null}
          {task.acceptance?.trim() ? (
            <span className="whitespace-pre-line">
              <span className="font-medium text-foreground">Done when </span>
              {task.acceptance.trim()}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="flex flex-wrap gap-2">
        <OpenTaskLink id={task.id} project={task.project} />
      </span>
    </ListRow>
  );
}

/** How long the ask has waited, as a length on the queue's log scale and as a
 * figure; a month or more wears warn. */
function AskAge({ days }: { days: number | null }) {
  if (days === null) return <span className="text-xs font-normal text-muted-foreground">age unknown</span>;
  const old = days >= 30;
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span aria-hidden className="h-1 w-12 overflow-hidden rounded-full bg-viz-track @max-xl:hidden">
        <span className={cn("block h-full rounded-full", old ? "bg-warn" : "bg-muted-foreground/60")} style={{ width: `${ageLength(days) * 100}%` }} />
      </span>
      <span className={cn("w-8 text-end", old ? "font-semibold text-warn" : "font-normal text-muted-foreground")}>
        <span className="sr-only">waiting </span>
        {ageLabel(days)}
      </span>
    </span>
  );
}
