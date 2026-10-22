import { eyebrowClass } from "@/components/surface/SectionLabel";
import type { WorkWeeks } from "@shared/work";
import { BarStrip, type BarStripPoint } from "@/components/viz/BarStrip";
import { FlowGraph } from "@/components/viz/FlowGraph";
import { PaceBar } from "@/components/viz/PaceBar";
import { WorkFlow, weekDaysIn, type WorkFlowRow } from "@/components/viz/WorkFlow";
import { formatInt } from "@/lib/format";
import { netFlow, stripTotals, weekLine, type EpicGraph, type InOut } from "@/lib/task-board-viz";
import { cn } from "@/lib/utils";
import { TaskTitleLink } from "./next/parts";
import { ProjectRail, type RailItem } from "./projects/ProjectRail";
import { attentionOrder, projectModel } from "./projects/project-model";

/** The board's panels share one frame: flat, on a hairline ring. */
const PANEL = "flex min-w-0 flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-border/70";

// --- in and out ---------------------------------------------------------------

/**
 * Is the work going out as fast as it comes in: the days' closings and
 * filings as two strips on one calendar, with the difference over the days
 * both were counted as the panel's one line, and done this week against last
 * week under them, as the Wall draws them. A strip nobody can count says so in
 * place of its bars.
 */
export function InOutPanel({ inOut, weeks = null, className }: { inOut: InOut; weeks?: WorkWeeks | null; className?: string }) {
  const closed = stripTotals(inOut.closed, inOut.today);
  const filed = inOut.filed === null ? null : stripTotals(inOut.filed, inOut.today);
  if (closed.days === 0 && (filed === null || filed.days === 0)) return null;
  const net = netFlow(inOut);
  const week = weeks?.done ?? null;
  const compared = weekLine(week);
  const ceiling = Math.max(0, ...[...inOut.closed, ...(inOut.filed ?? [])].map((point) => point.v ?? 0));
  return (
    <section aria-label="In and out" data-tasks-in-out="" className={cn(PANEL, "h-full", className)}>
      <header className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className={cn("m-0", eyebrowClass)}>In and out</h2>
          <span className="whitespace-nowrap text-xs text-muted-foreground">last {inOut.closed.length} days</span>
        </div>
        {net ? <p className="m-0 text-sm font-medium text-foreground [text-wrap:balance]">{netLine(net)}</p> : null}
        {compared ? <p className="m-0 text-sm text-muted-foreground [text-wrap:balance]" data-tasks-week-line="">{compared}</p> : null}
      </header>
      <div className="flex flex-1 flex-col gap-5">
        <FlowStrip label="Closed" points={inOut.closed} today={inOut.today} tone="text-milestone" totals={closed} max={ceiling} />
        {inOut.filed !== null && filed !== null ? (
          <FlowStrip label="Filed" points={inOut.filed} today={inOut.today} tone="text-spark" totals={filed} max={ceiling} />
        ) : (
          <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground" data-tasks-strip="filed">
            <span className="font-medium">Filed a day</span>
            <span>not in the saved snapshot</span>
          </div>
        )}
        {/* The two weeks' done as one bar: this week so far filled, where
            last week stood by today marked, last week's whole the ruled end. */}
        {weeks && week && week.now !== null && week.lastWeek !== null ? (
          <div className="flex flex-col gap-1.5" data-tasks-week="">
            <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
              <span className="font-medium">Done this week</span>
              <span className="whitespace-nowrap tabular-nums">
                <b className="text-sm font-semibold text-foreground">{formatInt(week.now)}</b> · {weekDaysIn(weeks.daysIn)}
              </span>
            </div>
            <PaceBar
              value={week.now}
              label="Done this week"
              previousAtSameDay={week.before}
              previousTotal={week.lastWeek}
              previousLabel="Done last week"
              tone="text-milestone"
              format={formatInt}
              showValue={false}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function netLine({ closed, filed, days }: { closed: number; filed: number; days: number }): string {
  const span = `last ${formatInt(days)} ${days === 1 ? "day" : "days"}`;
  if (closed === filed) return `Closed as many as filed, ${span}`;
  return closed > filed
    ? `Closed ${formatInt(closed - filed)} more than filed, ${span}`
    : `Filed ${formatInt(filed - closed)} more than closed, ${span}`;
}

function FlowStrip({ label, points, today, tone, totals, max }: {
  label: "Closed" | "Filed";
  points: readonly BarStripPoint[];
  today: string;
  tone: string;
  totals: ReturnType<typeof stripTotals>;
  /** The two strips' shared ceiling, so a day's bars compare across them. */
  max: number;
}) {
  const word = label.toLowerCase();
  const average = totals.average;
  return (
    <div className="flex min-h-24 flex-1 flex-col gap-1.5" data-tasks-strip={word}>
      <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
        <span className="font-medium">{label} a day</span>
        <span className="whitespace-nowrap tabular-nums">
          <b className="text-sm font-semibold text-foreground">{formatInt(totals.total)}</b> in {formatInt(totals.days)} {totals.days === 1 ? "day" : "days"}
        </span>
      </div>
      <BarStrip
        data={points}
        tone={tone}
        provisionalFrom={today}
        baseline={average === null ? null : { value: average, label: `avg ${perDay(average)} a day` }}
        format={(value) => `${formatInt(value)} ${word}`}
        max={max}
        ariaLabel={`Tasks ${word} a day, last ${points.length} days`}
        className="h-auto min-h-16 flex-1"
      />
    </div>
  );
}

function perDay(value: number): string {
  return value < 10 ? value.toFixed(1) : formatInt(Math.round(value));
}

// --- work by project ---------------------------------------------------------------

/**
 * Each project's week: done against what is still open, on one scale. The
 * Wall's own chart, without its figures: the answer above already states
 * them, with the partial-read marks this board needs and the chart does not
 * carry.
 */
export function WorkByProject({ rows, className }: { rows: readonly WorkFlowRow[]; className?: string }) {
  return (
    <div className={cn(PANEL, className)} data-tasks-work="">
      <WorkFlow rows={rows} title="Work by project" figures={false} />
    </div>
  );
}

// --- one epic -------------------------------------------------------------------

/**
 * One epic's tasks and what each waits on, the chain a blocked or parked task
 * holds drawn broken where it breaks. Which epic is the URL's (`?epic=`); the
 * default is the one most stuck.
 */
export function EpicPanel({ graphs, selected, onSelect, nowMs, className }: {
  graphs: readonly EpicGraph[];
  selected: string | null;
  onSelect: (id: string) => void;
  nowMs: number;
  className?: string;
}) {
  const graph = graphs.find((candidate) => candidate.id === selected) ?? graphs[0];
  if (!graph) return null;
  const facts = [
    graph.project.name,
    graph.progress ? `${formatInt(graph.progress.closed)} of ${formatInt(graph.progress.total)} done` : null,
    graph.stuck > 0 ? `${formatInt(graph.stuck)} stuck` : null,
    graph.asks > 0 ? `${formatInt(graph.asks)} ${graph.asks === 1 ? "needs" : "need"} you` : null,
  ].filter(Boolean);
  return (
    <section aria-label={`${graph.title}: what each task waits on`} data-tasks-epic={graph.id} className={cn(PANEL, className)}>
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className={cn("m-0", eyebrowClass)}>Epic</h2>
          <TaskTitleLink task={{ id: graph.id, title: graph.title, project: graph.project.asset }} className="text-base font-semibold" />
          <span className="text-xs text-muted-foreground">{facts.join(" · ")}</span>
        </div>
      </header>
      {graphs.length > 1 ? (
        <>
          <ProjectRail items={railItems(graphs, nowMs)} selected={graph.id} onSelect={onSelect} label="Epics" />
          {/* The pick as a native control too, out of sight and out of the
              tab order: the rail is the control a person uses. */}
          <label className="sr-only" htmlFor="tasks-epic" aria-hidden>Epic</label>
          <select id="tasks-epic" className="sr-only" tabIndex={-1} aria-hidden value={graph.id} onChange={(event) => onSelect(event.target.value)}>
            {graphs.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title} · {candidate.project.name}
              </option>
            ))}
          </select>
        </>
      ) : null}
      <FlowGraph nodes={graph.nodes} edges={graph.edges} nowMs={nowMs} ariaLabel={`${graph.title}: its tasks and what each waits on`} />
      {graph.hidden > 0 ? (
        <span className="text-xs text-muted-foreground">
          {formatInt(graph.hidden)} more {graph.hidden === 1 ? "task" : "tasks"} in this epic are in the list below
        </span>
      ) : null}
    </section>
  );
}

/** The epics the graph can draw, as the project rail's cards, in "Needs
 * attention first" order; the ring is the rollup's all-time count when the
 * snapshot carries one. */
function railItems(graphs: readonly EpicGraph[], nowMs: number): RailItem[] {
  const projects = [...new Map(graphs.map((graph) => [graph.project.asset, graph.project])).values()];
  const records = new Map(projectModel({ projects, snapshots: [], now: new Date(nowMs) })
    .flatMap((site) => site.projects).map((record) => [record.id, record]));
  return graphs.flatMap((graph) => {
    const record = records.get(graph.id);
    return record ? [{ record: { ...record, title: graph.title }, progress: graph.progress }] : [];
  }).sort((a, b) => attentionOrder(a.record, b.record));
}
