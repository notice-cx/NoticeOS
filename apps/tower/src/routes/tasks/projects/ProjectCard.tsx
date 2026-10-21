import { useId, useState } from "react";
import { Bot, Circle, ListChecks, User } from "lucide-react";
import { Link } from "react-router-dom";
import { taskOperationAvailable } from "@shared/tasks";
import { Button } from "@/components/ui/button";
import { TaskProgressBar } from "@/components/viz/TaskProgressBar";
import { useTasksLive } from "@/hooks/useTasks";
import { agentMaker } from "@/lib/agent-work";
import { formatInt, formatSeriesDate, formatUsd } from "@/lib/format";
import { isGate } from "@/lib/task-board-read";
import { taskPath } from "@/lib/task-path";
import { cn } from "@/lib/utils";
import { useAskActions } from "../ask-actions";
import { KindIcon, ProjectStateChip } from "./project-face";
import type { ProjectAsk, ProjectNext, ProjectRecord } from "./project-model";

/** A question older than this reads as a project stuck on it. */
const STUCK_DAYS = 14;

/** The 3 px rule along a card's top: what needs the operator in warn, P0/P1
 * in urgent, work set aside muted, nothing on the rest. */
const RULE: Partial<Record<ProjectRecord["state"], string>> = {
  "needs-you": "bg-warn",
  urgent: "bg-urgent",
  parked: "bg-muted-foreground/40",
  "not-started": "bg-muted-foreground/40",
};

/** "6 of 9 done · 2 blocked · ≈ $1,200 /mo at stake". */
export function projectFacts(record: ProjectRecord): string {
  const parts = [
    record.total === 0 ? "No tasks yet" : `${formatInt(record.closed)} of ${formatInt(record.total)} done`,
    record.ask && record.agesDays !== null && record.agesDays > STUCK_DAYS
      ? `stuck ${formatInt(record.agesDays)} days on one question`
      : record.counts.blocked > 0 ? `${formatInt(record.counts.blocked)} blocked` : null,
    record.valuePerMonth !== null ? `≈ ${formatUsd(record.valuePerMonth)} /mo at stake` : null,
    record.state === "done" && record.closedAt ? `Closed ${formatSeriesDate(record.closedAt.slice(0, 10))}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/**
 * One project: its kind, title and state, a segment per task, how far along
 * it is, and the next thing in it: the question waiting on the operator with
 * its verb, or the next task and who holds it. The whole card opens the
 * project's page; the verbs and the task's own link sit over that link.
 */
export function ProjectCard({ record, href, projectScope }: {
  record: ProjectRecord;
  href: string;
  /** The project a task link names, where the workspace selects one. */
  projectScope?: string;
}) {
  const rule = RULE[record.state];
  return (
    <article
      className="relative flex min-w-[min(280px,100%)] basis-[280px] flex-col gap-2.5 overflow-hidden rounded-xl bg-card p-4 ring-1 ring-border/70 max-sm:basis-full"
      style={{ flexGrow: Math.max(1, record.open) }}
      data-project-card={record.id}
      data-state={record.state}
    >
      {rule ? <span aria-hidden className={cn("absolute inset-x-0 top-0 h-[3px]", rule)} data-project-rule="" /> : null}
      <header className="flex items-start gap-2.5">
        <KindIcon record={record} />
        <Link
          to={href}
          className="min-w-0 flex-1 text-sm font-semibold leading-snug text-foreground [overflow-wrap:anywhere] outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-[3px] focus-visible:after:ring-ring"
          data-project-link=""
        >
          {record.title}
        </Link>
        <ProjectStateChip record={record} />
      </header>
      <TaskProgressBar segments={record.segments} />
      <p className="m-0 text-xs tabular-nums text-muted-foreground" data-project-facts="">{projectFacts(record)}</p>
      {record.state === "done" ? null : record.ask ? (
        <AskFooter ask={record.ask} actionable={record.actionable} projectScope={projectScope} />
      ) : record.next ? (
        <NextFooter next={record.next} projectScope={projectScope} />
      ) : null}
    </article>
  );
}

const FOOTER = "relative z-10 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-border pt-2.5 text-xs";

function TaskLink({ id, title, projectScope }: { id: string; title: string; projectScope?: string }) {
  return (
    <Link to={taskPath(id, projectScope)} className="min-w-0 font-medium text-foreground [overflow-wrap:anywhere] underline-offset-4 hover:underline">
      {title}
    </Link>
  );
}

/** The question and its verb, the same verbs the board's queue offers (`useAskActions`). */
function AskFooter({ ask, actionable, projectScope }: { ask: ProjectAsk; actionable: boolean; projectScope?: string }) {
  const capabilities = useTasksLive();
  const reasonId = useId();
  const [choosing, setChoosing] = useState(false);
  const unavailable = "Unavailable in this workspace.";
  const supported = taskOperationAvailable(capabilities, isGate(ask.task) ? "resolve" : "respond");
  const { buttons, box } = useAskActions({
    ask: ask.verb,
    id: ask.task.id,
    title: ask.task.title,
    project: ask.task.project,
    placement: "header",
    describedBy: reasonId,
    choices: ask.task.choices ?? null,
    disabledReason: supported ? null : unavailable,
    chooseDisabledReason: taskOperationAvailable(capabilities, "choose") ? null : unavailable,
  });
  const choose = ask.verb === "choose" && (ask.task.choices ?? null) !== null;
  return (
    <div className={cn(FOOTER, "flex-col items-stretch")} data-project-next="ask">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="min-w-0 flex-1 basis-40">
          <TaskLink id={ask.task.id} title={ask.task.title} projectScope={projectScope} />
        </span>
        {actionable ? (
          <span className="flex flex-wrap items-center gap-2">
            {choose ? (
              <Button type="button" size="sm" aria-expanded={choosing} onClick={() => setChoosing((open) => !open)} data-task-action="choose">
                <ListChecks aria-hidden />
                Choose
              </Button>
            ) : buttons}
          </span>
        ) : null}
        {!supported ? <span id={reasonId} className="sr-only">{unavailable}</span> : null}
      </div>
      {actionable && (!choose || choosing) ? box : null}
    </div>
  );
}

/** The next task and who holds it, or that nobody does yet. */
function NextFooter({ next, projectScope }: { next: ProjectNext; projectScope?: string }) {
  const Glyph = next.who === null ? Circle : agentMaker(next.who) !== null ? Bot : User;
  return (
    <div className={FOOTER} data-project-next={next.who === null ? "nobody" : "held"}>
      <Glyph aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <TaskLink id={next.task.id} title={next.task.title} projectScope={projectScope} />
        <span className="text-muted-foreground"> · {next.who ?? "nobody yet"}</span>
      </span>
    </div>
  );
}
