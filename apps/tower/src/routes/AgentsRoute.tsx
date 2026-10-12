import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { RouteLoading } from "@/components/RouteLoading";
import { TaskHubUnavailable } from "@/components/TaskSourceSection";
import { PageAnswer } from "@/components/surface/PageAnswer";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { StatusBanner } from "@/components/surface/StatusBanner";
import { RaceChart } from "@/components/viz/RaceChart";
import { StackedWeeks } from "@/components/viz/StackedWeeks";
import { useAgentWork } from "@/hooks/useAgentWork";
import { useTasksLive } from "@/hooks/useTasks";
import { useNow } from "@/hooks/useNow";
import { formatHours, medianOf, type AgentWork } from "@/lib/agent-work";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AgentFeed, AgentTrophies, PANEL, WorkerRows, taskHref } from "./agents/agent-panels";

const DAY_MS = 86_400_000;

/**
 * `/agents`: who did the work. The answer is the last seven days' closes
 * against the seven before; then eight weeks of closes stacked by worker, each
 * worker's row, the week's ranking of agents and the models they named, its
 * leaders, and the claims and closes themselves with their evidence.
 */
export function AgentsRoute() {
  const nowMs = useNow();
  const projectSelection = useTasksLive().projectSelection === true;
  const read = useAgentWork(nowMs);
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 md:p-6" data-agents-page="">
      <PageHeader title="Agents" />
      {!read.live ? (
        <div className={PANEL}><EmptyState title="Not available in the read-only snapshot" hint="Open Agents in the local NoticeOS." /></div>
      ) : read.projects === 0 && !read.pending ? (
        <TaskHubUnavailable />
      ) : read.work === null ? (
        read.pending ? <RouteLoading /> : <div className={PANEL}><EmptyState title="Couldn't read any task project" hint={read.broken.join(", ")} /></div>
      ) : (
        <AgentsBoard work={read.work} nowMs={nowMs} broken={read.broken} complete={read.complete} projectSelection={projectSelection} />
      )}
    </div>
  );
}

function AgentsBoard({ work, nowMs, broken, complete, projectSelection }: {
  work: AgentWork; nowMs: number; broken: readonly string[]; complete: boolean; projectSelection: boolean;
}) {
  const href = taskHref(projectSelection);
  const change = work.lastWeek === null ? null : work.week - work.lastWeek;
  const agents = work.workers.filter((worker) => worker.agent);
  const median = medianOf(agents.flatMap((worker) => worker.medianHours === null ? [] : [worker.medianHours]));
  const ticks = Array.from({ length: 7 }, (_, index) => {
    const ms = Math.ceil(work.race.from / DAY_MS) * DAY_MS + index * DAY_MS;
    return [ms, new Date(ms).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })] as const;
  }).filter(([ms]) => ms <= work.race.to);
  return (
    <>
      <StatusBanner open={broken.length > 0} severity="warn" subject="agents:projects"
        lead={`${broken.length} ${broken.length === 1 ? "project" : "projects"} could not be read`}>
        {broken.join(", ")}: their work is missing from every figure below.
      </StatusBanner>
      <div data-surface-hero="" className="flex flex-col gap-5">
        <PageAnswer
          answer={`${formatInt(work.week)} ${work.week === 1 ? "task" : "tasks"} closed in 7 days`}
          detail={change === null ? "Still loading the 7 days before"
            : change === 0 ? "As many as the 7 days before"
            : `${formatInt(Math.abs(change))} ${change > 0 ? "more" : "fewer"} than the 7 days before (${formatInt(work.lastWeek!)})`}
          figures={[
            { label: "In progress", value: formatInt(work.inHand), mark: "agents-in-hand" },
            { label: "Blocked", value: formatInt(work.blocked), tone: work.blocked > 0 ? "text-warn" : undefined, mark: "agents-blocked" },
            { label: "Claim to close", value: median === null ? "not yet" : formatHours(median), note: median === null ? undefined : "median", mark: "agents-median" },
          ]}
          marks={{ "data-agents-answer": "" }}
        />
        <section aria-label="Velocity" data-agent-velocity="" className={cn(PANEL, "shadow-raised")}>
          <header className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className={cn("m-0", eyebrowClass)}>Velocity · tasks closed a week</h2>
            <span className="text-xs text-muted-foreground">{complete ? "last 8 weeks" : "last 8 weeks · some projects still loading"}</span>
          </header>
          <StackedWeeks weeks={work.velocity.weeks} keys={work.velocity.keys} names={work.velocity.names} unit="tasks"
            ariaLabel="Tasks closed a week, by who closed them" className="min-h-56" />
        </section>
      </div>
      {/* Laid out by its own width, not the window's, as the Tasks board is. */}
      <div className="@container">
      <div className="grid gap-4 @5xl:grid-cols-12 [&>*]:min-w-0">
        <div className="@5xl:col-span-7"><WorkerRows workers={work.workers} nowMs={nowMs} href={href} /></div>
        <section aria-label="Ranking" data-agent-race="" className={cn(PANEL, "@5xl:col-span-5")}>
          <h2 className={cn("m-0", eyebrowClass)}>Ranking · agents and models, last 7 days</h2>
          {work.race.players.length === 0 ? <EmptyState size="sm" title="No agent closed a task in the last 7 days" /> : (
            <RaceChart
              entries={work.race.players.map((player) => ({ key: player.key, name: player.model ? `${player.name} · ${player.model}` : player.name,
                at: player.closes, score: player.points }))}
              from={work.race.from} to={work.race.to} unit="task" ticks={ticks}
              ariaLabel="Tasks closed in the last 7 days, running total per agent and model, ranked by points" className="min-h-64" />
          )}
          <span className="text-xs text-muted-foreground">Ranked by points: a top-priority task counts 5, high 3, normal 2, low and lowest 1.</span>
        </section>
      </div>
      </div>
      <AgentTrophies trophies={work.trophies} />
      <AgentFeed events={work.events} nowMs={nowMs} href={href} />
    </>
  );
}

export default AgentsRoute;
