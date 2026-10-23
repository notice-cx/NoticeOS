import { Fragment } from "react";
import { taskOperationAvailable, type TasksCapabilities } from "@shared/tasks";
import { SelectBox, SelectToggle, useSelection } from "@/components/SelectionBar";
import { ListRow } from "@/components/surface/ListPanel";
import { DecisionQueue, ageLabel, ageLength } from "@/components/viz/DecisionQueue";
import { useTasksLive } from "@/hooks/useTasks";
import { askVerb, isGate, type BoardProject, type BoardTask, type InboxAsk } from "@/lib/task-board-read";
import { queueItem } from "@/lib/task-board-viz";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAskActions } from "./ask-actions";
import { AskSelection } from "./ask-selection";
import { TaskTitleLink } from "./next/parts";
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

/** Whether this ask's verb can run here: a live project and a workspace
 * whose permissions offer the verb. */
function answerable(ask: Ask, capabilities: TasksCapabilities): boolean {
  return ask.project.actionable && taskOperationAvailable(capabilities, isGate(ask.task) ? "resolve" : "respond");
}

/**
 * Waiting on you, drawn as a queue: how many wait, how old the waits are,
 * then each ask with its age as a length and its verbs on the row. A row
 * opens in place for the evidence; no row opens on arrival, because the
 * queue mounts on the snapshot and is reordered by the live read, and the
 * row that ends up first would be whichever happened to mount first.
 *
 * Select turns the rows into a selection, every row shown, so several asks
 * decided together take one action (`AskSelection`) instead of one per row.
 * It is offered when two or more rows can be answered here. The All tasks
 * table's Select is the same pieces (`SelectionBar`).
 */
export function AskQueue({ asks, total, complete, filtered, nowMs, showProject, className }: {
  asks: readonly Ask[];
  /** The whole queue, which the snapshot's rows may undercount. */
  total: number;
  complete: boolean;
  filtered: boolean;
  nowMs: number;
  showProject: boolean;
  className?: string;
}) {
  const items = asks.map((ask) => queueItem(ask, nowMs));
  const capabilities = useTasksLive();
  const selection = useSelection();
  const { selecting, picked } = selection;
  const selectable = asks.filter((ask) => answerable(ask, capabilities));
  // A row answered or gone since it was picked leaves the selection with it.
  const chosen = selectable.filter((ask) => picked.has(ask.task.id));
  return (
    <DecisionQueue
      items={items}
      total={total > 0 ? total : null}
      partial={!complete}
      totalNote={complete ? undefined : "partial read"}
      title="Your decisions"
      limit={selecting ? Math.max(asks.length, ASK_ROWS) : ASK_ROWS}
      empty={!complete ? "Waiting work is unknown for unread projects." : total === 0 ? "No decisions for you." : filtered ? "No decisions match these filters." : "No decision details read."}
      headerAction={selecting || selectable.length >= 2 ? <SelectToggle selection={selection} marks={{ "data-inbox-select-mode": "" }} /> : null}
      toolbar={selecting ? <AskSelection chosen={chosen} selectable={selectable} onPick={selection.pick} onSent={selection.leave} /> : null}
      className={className}
    >
      {asks.map((ask, index) => (
        <AskRow key={ask.task.id} {...ask} ageDays={items[index]!.ageDays} showProject={showProject} capabilities={capabilities}
          selection={selecting && answerable(ask, capabilities) ? { checked: picked.has(ask.task.id), toggle: () => selection.flip(ask.task.id) } : null} />
      ))}
    </DecisionQueue>
  );
}

/** What a row's caption adds about its ask; a plain question adds nothing. */
const ROW_ASKS: Readonly<Record<InboxAsk, string | null>> = {
  approve: "needs your approval",
  answer: null,
  choose: "needs your choice",
};

/**
 * One ask, answered on its row (`useAskActions`): a claimable `human`-labelled
 * task, or an open gate holding other work. Warn at every priority: the
 * operator being the blocker is not a failure. The verbs stay quiet until the
 * row is pointed at, so six identical buttons never outshout six asks. A
 * task with choices draws its question and options under its title, so the
 * pick is one press from the inbox.
 */
function AskRow({ project, task, ageDays, showProject, capabilities, selection }: Ask & {
  ageDays: number | null;
  showProject: boolean;
  capabilities: TasksCapabilities;
  /** While the queue is a selection: whether this row is picked. */
  selection: { checked: boolean; toggle: () => void } | null;
}) {
  // The verbs, the options and the answer box are the task page's too.
  const verb = askVerb(task);
  const unavailable = "Unavailable in this workspace.";
  const supported = taskOperationAvailable(capabilities, isGate(task) ? "resolve" : "respond");
  const { buttons, box } = useAskActions({ ask: verb, id: task.id, title: task.title, project: task.project, placement: "row",
    choices: task.choices ?? null,
    disabledReason: supported ? null : unavailable,
    chooseDisabledReason: taskOperationAvailable(capabilities, "choose") ? null : unavailable });
  const evidence = [task.description, task.acceptance].some((value) => (value ?? "").trim() !== "");
  const proceeds = task.decisionImpact?.proceeds ?? [];

  return (
    <ListRow
      {...askFace(task)}
      title={task.title}
      // The project and what the row asks, never the task's id, which is on
      // the task's own page.
      caption={[showProject ? project.name : null, ROW_ASKS[verb]].filter(Boolean).join(" · ") || null}
      value={<AskAge days={ageDays} />}
      marks={{ "data-inbox-row": task.id, "data-subject": `task:${task.id}` }}
      leading={selection ? (
        <SelectBox checked={selection.checked} onToggle={selection.toggle} label={task.title} marks={{ "data-inbox-select": task.id }} />
      ) : undefined}
      // While selecting, the selection's verbs replace the row's own.
      rowActions={project.actionable && !selection && buttons !== null ? (
        <span className="flex flex-wrap items-center gap-2 opacity-60 transition-opacity group-hover/ask:opacity-100 group-focus-within/ask:opacity-100 max-sm:opacity-100">
          {buttons}
        </span>
      ) : undefined}
      below={<>
        {project.actionable && !selection ? box : null}
        <span className="block pb-2 pe-2 ps-9 text-xs text-muted-foreground" data-inbox-proceeds>
          <span className="font-medium text-foreground">After your answer: </span>
          {proceeds.length
            ? <>{proceeds.slice(0, 2).map((row, index) => (
              <Fragment key={row.id}>{index > 0 ? "; " : null}<TaskTitleLink task={{ ...row, project: task.project }} /></Fragment>
            ))}{proceeds.length > 2 ? `; ${formatInt(proceeds.length - 2)} more ${proceeds.length === 3 ? "task" : "tasks"}` : ""}</>
            : isGate(task) ? "Only the stated action is approved."
              : task.issueType === "decision" ? "The decision is recorded."
                : "An agent can continue this task."}
        </span>
      </>}
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
