import type { ReactNode } from "react";
import { CircleHelp, TriangleAlert, Zap, type LucideIcon } from "lucide-react";
import { ageMs, formatAge } from "@shared/freshness";
import { READ_ONLY_TASKS_HINT } from "@shared/tasks";
import type { WorkDoneWeek } from "@shared/work";
import { ReadFailed } from "@/components/ReadFailed";
import { PageSkeleton } from "@/components/Skeleton";
import { TaskHubUnavailable } from "@/components/TaskSourceSection";
import { FinishLine } from "@/components/surface/FinishLine";
import { PageAnswer } from "@/components/surface/PageAnswer";
import { StatusBanner } from "@/components/surface/StatusBanner";
import { LAST_WEEK_BY_TODAY, WorkWeekChip } from "@/components/viz/WorkFlow";
import { cn } from "@/lib/utils";
import { WorkingNow } from "../TasksBoard";
import { NextDecision } from "./NextDecision";
import { NotNow } from "./NotNow";
import { AgentsNext, ThenForYou } from "./RankedRows";
import { TasksBrief } from "./TasksBrief";
import { epicOf, nextSentence, waitedShort } from "./next-read";
import { useNextBoard, type NextBoard } from "./useNextBoard";

/** Where Focus opens: the whole board, or one site's, at one decision. */
export function focusPath(scope: string | null, task?: string): string {
  const query = new URLSearchParams({ ...(scope === null ? {} : { project: scope }), ...(task === undefined ? {} : { task }) }).toString();
  return `/tasks/focus${query ? `?${query}` : ""}`;
}

/**
 * The Tasks page's Next tab: one sentence, the decision to take first with
 * everything that puts it first, then every other decision by what it is
 * worth, what the agents take next and what is held back. A site's Tasks tab
 * draws it `compact`: the decisions only, over the board.
 */
export function NextTab({ scope = null, compact = false }: { scope?: string | null; compact?: boolean }) {
  const next = useNextBoard(scope);
  const { data, drawn, isError, error, isFetching, refetch, spokes, byId, ranked, countsComplete, shownAt, now } = next;

  if (!data || !drawn) {
    if (compact) return null;
    return isError && !data ? (
      <ReadFailed title="Couldn't load tasks" subject="read:tasks" error={error} retrying={isFetching} onRetry={() => void refetch()} />
    ) : (
      <PageSkeleton subject="read:tasks" shape="list" />
    );
  }
  if (spokes.length === 0) return compact ? null : <TaskHubUnavailable />;

  const [top, ...rest] = ranked.decisions;
  if (compact && !top) return null;
  const finish = top && countsComplete ? { age: shownAt ? `read ${formatAge(ageMs(now, shownAt))} ago` : null } : null;
  const decision = top ? (
    <NextDecision row={top} project={byId.get(top.task.project) ?? null} epic={epicOf(next, top.task)} of={ranked.decisions.length} />
  ) : null;
  const then = rest.length > 0 ? (
    <ThenForYou rows={rest} projects={byId} focusTo={focusPath(scope)} finish={finish} />
  ) : finish ? <FinishLine line="That's every decision for you." age={finish.age} className="min-h-0 py-2.5" /> : null;

  if (compact) {
    return (
      <div className="flex w-full flex-col gap-5" data-tasks-next={scope ?? "all"}>
        {decision}
        {then}
      </div>
    );
  }

  const facts = boardFacts(next);
  return (
    <div className="flex w-full max-w-5xl flex-col gap-7" data-tasks-next={scope ?? "all"}>
      {next.live ? null : (
        <div data-tasks-readonly="">
          <StatusBanner severity="info" lead="Read-only snapshot" subject="tasks:snapshot">
            {READ_ONLY_TASKS_HINT}
          </StatusBanner>
        </div>
      )}
      <div data-surface-hero className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <PageAnswer
            answer={nextSentence(ranked, { complete: countsComplete })}
            detail={<Facts {...facts} />}
            marks={{ "data-next-answer": top ? "decision" : ranked.agents.length > 0 ? "agents" : "clear" }}
          />
          <WorkingNow tasks={next.allTasks} />
          <TasksBrief
            ranked={ranked}
            projects={byId}
            done={facts.done.week ? { count: facts.done.week.now ?? 0, move: facts.done.week.move } : null}
            focusTo={(id) => focusPath(scope, id)}
            nowMs={now}
          />
        </div>
        {decision}
      </div>
      {then}
      {ranked.agents.length > 0 ? <AgentsNext rows={ranked.agents} projects={byId} nowMs={now} /> : null}
      {ranked.notNow.length > 0 ? <NotNow rows={ranked.notNow} projects={byId} /> : null}
    </div>
  );
}

interface BoardFacts {
  /** A count, `12+` for a lower bound, or null when nothing measured it. */
  decisions: string | null;
  oldest: number | null;
  urgent: string | null;
  blocked: string | null;
  done: { value: string | null; week: WorkDoneWeek | null };
}

/** The board's own counts, read the way its answer reads them: the week's
 * reading where the history holds one, else the read's counts, a lower bound
 * where a project could not be read. */
function boardFacts(next: NextBoard): BoardFacts {
  const { counts, totals, weeks, projects, missingProjects, doneRead, answered, ranked } = next;
  const anyRead = missingProjects < projects.length;
  const bounded = (complete: number | null, observed: number | null): string | null =>
    complete !== null ? String(complete) : observed === null || !anyRead ? null : `${observed}+`;
  const less = (count: number | null) => (count === null ? null : Math.max(0, count - answered));
  const ages = ranked.decisions.flatMap((row) => (row.ageDays === null ? [] : [row.ageDays]));
  const week = weeks?.done.now != null ? weeks.done : null;
  return {
    decisions: bounded(less(counts.waiting), less(totals.waiting)),
    oldest: ages.length === 0 ? null : Math.max(...ages),
    urgent: weeks?.urgent.now != null ? String(weeks.urgent.now) : bounded(counts.urgent, totals.urgent),
    blocked: weeks?.blocked.now != null ? String(weeks.blocked.now) : bounded(counts.blocked, totals.blocked),
    done: { value: week ? String(week.now) : bounded(null, doneRead), week },
  };
}

/** The facts under the sentence, each with its glyph; a count nothing
 * measured is a word. */
function Facts({ decisions, oldest, urgent, blocked, done }: BoardFacts) {
  const waiting = decisions !== null && decisions !== "0";
  const oldestWords = waitedShort(oldest);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-4 gap-y-1" data-next-facts="">
      <Fact icon={CircleHelp} tone={waiting ? "text-warn" : null} mark="decisions" strong={waiting}>
        {decisions === null ? "decisions unknown"
          : decisions === "0" ? "No decisions for you"
            : `${decisions} ${decisions === "1" ? "decision" : "decisions"} for you${oldestWords ? ` · oldest ${oldestWords}` : ""}`}
      </Fact>
      <Fact icon={Zap} tone={urgent !== null && urgent !== "0" ? "text-urgent" : null} mark="urgent">
        {urgent === null ? "urgent unknown" : `${urgent} urgent`}
      </Fact>
      <Fact icon={TriangleAlert} tone={blocked !== null && blocked !== "0" ? "text-warn" : null} mark="blocked">
        {blocked === null ? "blocked unknown" : `${blocked} blocked`}
      </Fact>
      <Fact mark="done">
        {done.value === null ? "done this week unknown" : `${done.value} done this week`}
        {done.week?.move ? <WorkWeekChip move={done.week.move} against={LAST_WEEK_BY_TODAY} className="ms-1.5" /> : null}
      </Fact>
    </span>
  );
}

function Fact({ icon: Icon, tone = null, mark, strong = false, children }: {
  icon?: LucideIcon;
  /** The glyph's ink, and the words' too when `strong`. */
  tone?: string | null;
  mark: string;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={cn("inline-flex flex-wrap items-baseline gap-x-1.5", strong && tone)} data-next-fact={mark}>
      {Icon ? <Icon aria-hidden className={cn("size-3.5 shrink-0 self-center", tone ?? "text-muted-foreground")} /> : null}
      {children}
    </span>
  );
}

