import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ageMs, formatAge } from "@shared/freshness";
import { taskActorLabel } from "@shared/tasks";
import { FinishLine } from "@/components/surface/FinishLine";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { pillControlClass } from "@/components/ui/pill";
import type { BoardProject } from "@/lib/task-board-read";
import type { RankedTask } from "@/lib/task-ranking";
import { cn } from "@/lib/utils";
import { useAskActions } from "../ask-actions";
import { heldSince, whyLine } from "./next-read";
import { useAskReasons } from "./NextDecision";
import { AgeBar, AskGlyph, LIST_ROWS, MoneyFigure, Rows, ShowAll, SiteMark, TaskTitleLink, rowClass } from "./parts";

/** Decisions shown under the first before Show all. */
const DECISION_ROWS = 5;

/**
 * The decisions after the first, in rank order, each with what it is worth,
 * how long it has waited and the verb that answers it. The list ends on the
 * board's own finish line, so it reads as finished when it is.
 */
export function ThenForYou({ rows, projects, focusTo, finish, ranked }: {
  rows: readonly RankedTask[];
  projects: ReadonlyMap<string, BoardProject>;
  /** Where Focus opens for this list. */
  focusTo: string;
  /** The finish line's reading age, or null when the list is not known to be whole. */
  finish: { age: string | null } | null;
  /** Whether any decision carries a card: the caption names the order in
   * force, and a board without a card is in the board's own order. */
  ranked: boolean;
}) {
  const [all, setAll] = useState(false);
  const { pathname, search } = useLocation();
  const shown = all ? rows : rows.slice(0, DECISION_ROWS);
  return (
    <section className="flex flex-col gap-2" data-then-for-you="">
      <SectionLabel
        title="Then, for you"
        caption={ranked ? "ranked by what each decision is worth, against the minutes it takes" : "by what each answer releases, then the longest wait"}
      >
        <Link
          to={focusTo}
          state={{ returnTo: `${pathname}${search}` }}
          className={cn(
            "text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline",
            pillControlClass,
            "max-sm:-my-2.5 max-sm:inline-flex max-sm:items-center",
          )}
          data-focus-link=""
        >
          Focus →
        </Link>
      </SectionLabel>
      {rows.length > 0 ? (
        <Rows>
          {shown.map((row) => (
            <DecisionRow key={row.task.id} row={row} project={projects.get(row.task.project) ?? null} />
          ))}
        </Rows>
      ) : null}
      {shown.length < rows.length ? <ShowAll count={rows.length} onShow={() => setAll(true)} marks={{ "data-then-show-all": "" }} /> : null}
      {/* The finish line closes a list that is all on screen; under Show all it would contradict it. */}
      {finish && shown.length === rows.length ? <FinishLine line="That's every decision for you." age={finish.age} className="min-h-0 py-2.5" /> : null}
    </section>
  );
}

/** One decision as a row: its rank, site, title and why, then the money
 * where a card puts any, the wait and the one verb that answers it. The verb,
 * the answer box and a choice's options are the board row's own
 * (`useAskActions`), so a decision is taken here as it is on All tasks,
 * options in one press; declining it (Close as) is the region's, the task
 * page's and All tasks', so a row carries one button. */
function DecisionRow({ row, project }: { row: RankedTask; project: BoardProject | null }) {
  const { task, ask } = row;
  const reasons = useAskReasons(row, project);
  const actions = useAskActions({
    ask,
    id: task.id,
    title: task.title,
    project: task.project,
    choices: task.choices ?? null,
    disabledReason: reasons.ask,
    chooseDisabledReason: reasons.choose,
    placement: "row",
    closeAs: false,
  });
  const why = whyLine(row.why, "this answer");
  const actionable = project?.actionable === true;
  const box = actions.box;
  return (
    <li className={cn(rowClass, "group/row")} data-then-row={task.id} data-inbox-row={task.id}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span className="w-7 shrink-0 text-figure-sm leading-none text-muted-foreground tabular-nums @max-[30rem]:hidden">
          <span className="sr-only">Rank </span>
          {row.rank}
        </span>
        <SiteMark site={task.project} name={project?.name ?? task.project} className="mt-0.5" />
        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
          <span className="flex items-start gap-1.5 text-sm font-medium">
            {ask ? <AskGlyph ask={ask} className="mt-[3px]" /> : null}
            <TaskTitleLink task={task} className="line-clamp-2" />
          </span>
          {why ? <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{why}</span> : null}
        </div>
        <div className="ms-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
          {row.card ? <MoneyFigure card={row.card} /> : null}
          <AgeBar days={row.ageDays} className="@max-[30rem]:hidden" />
          {actionable ? (
            <span className="flex flex-wrap items-center gap-2 opacity-60 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 max-sm:opacity-100">
              {actions.buttons}
            </span>
          ) : null}
        </div>
      </div>
      {actionable && box ? <div className="flex flex-col gap-2" data-then-box={task.id}>{box}</div> : null}
    </li>
  );
}

/**
 * What the agents take next: what is being worked first, then the ready work
 * by what its card is worth. Nothing here waits on the operator.
 */
export function AgentsNext({ rows, projects, nowMs }: {
  rows: readonly RankedTask[];
  projects: ReadonlyMap<string, BoardProject>;
  nowMs: number;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, LIST_ROWS);
  return (
    <section className="flex flex-col gap-2" data-agents-next="">
      <SectionLabel title="Agents, next up" caption="what the agents take next, and why · nothing here needs you" />
      <Rows>
        {shown.map((row) => (
          <AgentRow key={row.task.id} row={row} project={projects.get(row.task.project) ?? null} nowMs={nowMs} />
        ))}
      </Rows>
      {shown.length < rows.length ? <ShowAll count={rows.length} onShow={() => setAll(true)} marks={{ "data-agents-show-all": "" }} /> : null}
    </section>
  );
}

/** Who is on it and for how long, or who takes it next. */
export function agentState(row: RankedTask, nowMs: number): string {
  const { task } = row;
  const who = task.assignee ? taskActorLabel(task.assignee, task.actors) : null;
  if (row.state === "in-progress") {
    const age = ageMs(nowMs, heldSince(task));
    return ["In progress", who ?? "nobody", age === null ? null : formatAge(age)].filter(Boolean).join(" · ");
  }
  return who ? `Ready · ${who} next` : "Ready · nobody yet";
}

function AgentRow({ row, project, nowMs }: { row: RankedTask; project: BoardProject | null; nowMs: number }) {
  const { task } = row;
  const why = whyLine(row.why, "it");
  const working = row.state === "in-progress";
  return (
    <li className={rowClass} data-agent-row={task.id} data-agent-state={row.state}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span
          aria-hidden
          className={cn("mt-1.5 size-2 shrink-0 rounded-full", working ? "bg-healthy" : "border border-muted-foreground")}
        />
        <SiteMark site={task.project} name={project?.name ?? task.project} className="mt-0.5" />
        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
          <TaskTitleLink task={task} className="text-sm font-medium" />
          <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {agentState(row, nowMs)}
            {why ? ` · ${why}` : ""}
          </span>
        </div>
        {row.card ? <span className="ms-auto"><MoneyFigure card={row.card} /></span> : null}
      </div>
    </li>
  );
}
