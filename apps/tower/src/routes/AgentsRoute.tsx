import { Fragment, type ReactNode } from "react";
import { useView } from "@/hooks/useView";
import { AGENT_SECTION_ORDER, agentViewPresentation, type AgentSection } from "./agents/agent-view";
import { PageHeader } from "@/components/PageHeader";
import { AgentMark } from "@/components/AgentMark";
import { EmptyState } from "@/components/EmptyState";
import { RouteLoading } from "@/components/RouteLoading";
import { TaskHubUnavailable } from "@/components/TaskSourceSection";
import { PageAnswer } from "@/components/surface/PageAnswer";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { StatusBanner } from "@/components/surface/StatusBanner";
import { RaceChart } from "@/components/viz/RaceChart";
import { StackedWeeks } from "@/components/viz/StackedWeeks";
import { useAgentWork } from "@/hooks/useAgentWork";
import { type AgentStats } from "@noticeos/contract/agent-stats";
import { Link } from "react-router-dom";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AgentTrophies, PANEL, WorkerRows } from "./agents/agent-panels";

const DAY_MS = 86_400_000;

/** Model activity from a dedicated server-side statistics read. */
export function AgentsRoute() {
  const read = useAgentWork();
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 md:p-6" data-agents-page="">
      <PageHeader title="Agents" />
      {!read.live ? (
        <div className={PANEL}><EmptyState title="Not available in the read-only snapshot" hint="Open Agents in the local NoticeOS." /></div>
      ) : read.projects === 0 && !read.pending && !read.failed ? (
        <TaskHubUnavailable />
      ) : read.work === null ? (
        read.pending ? <RouteLoading /> : <div className={PANEL}><EmptyState title="Couldn't read any task project" hint={read.broken.join(", ")} /></div>
      ) : (
        <AgentsBoard work={read.work} broken={read.broken} complete={read.complete} failed={read.failed} />
      )}
    </div>
  );
}

function AgentsBoard({ work, broken, complete, failed }: {
  work: AgentStats; broken: readonly string[]; complete: boolean; failed: boolean;
}) {
  const { view } = useView();
  const presentation = agentViewPresentation(view.id, work);
  const change = work.week - work.lastWeek;
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
      <StatusBanner open={failed} severity="warn" subject="agents:refresh" lead="Couldn't refresh agent statistics">
        Showing the last successful read.
      </StatusBanner>
      <div data-surface-hero="" className="flex flex-col gap-5">
        <PageAnswer
          answer={presentation.answer}
          detail={complete && (view.id === "overview" || view.id === "growth") ? change === 0 ? "As many as the 7 days before"
            : `${formatInt(Math.abs(change))} ${change > 0 ? "more" : "fewer"} than the 7 days before (${formatInt(work.lastWeek!)})` : undefined}
          figures={presentation.figures}
          marks={{ "data-agents-answer": "" }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2" data-agent-evidence="">
        <Link to="/tasks" className="text-sm font-medium underline-offset-2 hover:underline">Review tasks →</Link>
        {view.id === 'growth' ? <Link to="/assets" className="text-sm font-medium underline-offset-2 hover:underline">View asset journeys and measurements →</Link> : null}
        {view.id === 'revenue' ? <Link to="/financials" className="text-sm font-medium underline-offset-2 hover:underline">View recorded financials →</Link> : null}
      </div>
      <div className="grid gap-4 lg:grid-cols-2" data-agent-section-order={view.id}>
        {AGENT_SECTION_ORDER[view.id].map(section => <Fragment key={section}>{({
          velocity: work.velocity.weeks.some(week => week.total > 0) ? <section aria-label="Velocity" data-agent-velocity="" className={cn(PANEL, "shadow-raised", (view.id === "overview" || work.workers.length === 0) && "lg:col-span-2")}>
          <header className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className={cn("m-0", eyebrowClass)}>Velocity · tasks closed a week</h2>
            <span className="text-xs text-muted-foreground">{complete ? "last 8 weeks" : "last 8 weeks · incomplete read"}</span>
          </header>
          <StackedWeeks weeks={work.velocity.weeks} keys={work.velocity.keys} names={work.velocity.names} unit="tasks"
            ariaLabel="Tasks closed a week, by model" className="min-h-56" />
        </section> : null,
          workers: work.workers.length > 0 ? <WorkerRows workers={work.workers} emphasis={view.id === "reliability" ? "blocked" : view.id === "delivery" ? "inHand" : undefined} /> : null,
          ranking: work.race.players.length > 0 ? <section aria-label="Ranking" data-agent-race="" className={PANEL}>
          <h2 className={cn("m-0", eyebrowClass)}>Ranking · models, last 7 days</h2>
          <RaceChart
              entries={work.race.players.map((player) => ({ key: player.key, name: player.name,
                mark: <AgentMark name={player.name} size="small" />, at: player.closes, score: player.points }))}
              from={work.race.from} to={work.race.to} unit="task" ticks={ticks}
              ariaLabel="Tasks closed in the last 7 days, running total per model, ranked by points" className="min-h-64" />
          <span className="text-xs text-muted-foreground">Ranked by points: a top-priority task counts 5, high 3, normal 2, low and lowest 1.</span>
        </section> : null,
          leaders: work.trophies.length > 0 ? <AgentTrophies trophies={work.trophies} className={view.id === 'overview' ? 'lg:col-span-2' : undefined} /> : null,
        } satisfies Record<AgentSection, ReactNode>)[section]}</Fragment>)}
      </div>
    </>
  );
}

export default AgentsRoute;
