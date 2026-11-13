import { CircleCheck, Hand, LoaderCircle, Ban, ListTodo, ChartBar } from "lucide-react";
import type { AssetCard, OperatorPosture } from "@shared/wall";
import { wallMetricTiles, type WallWidget, type WallMetricSource } from "@shared/wall-layout";
import type { CSSProperties, ReactNode } from "react";
import { WallMetricBinding } from "./WallMetricEditing";
import { sumWorkWeeks, weekMove, WORK_POLL_CADENCE_HOURS, type WeekMove } from "@shared/work";
import { isAmber } from "@shared/freshness";
import { operatorWaiting } from "@/lib/operator-posture";
import { shiftRevenueDate } from "@shared/revenue-projection";
import { formatInt } from "@/lib/format";
import { CumulativeCompareMetric, MetricTile, NumberMetric, type MetricMovement } from "./MetricWidgets";
import { WorkStatus } from "./WorkStatus";
import "./WallWork.css";
import "./WallRowHeading.css";

export interface WallWorkProps {
  assets: readonly AssetCard[];
  operator: OperatorPosture | null | undefined;
  nowMs: number;
  widget?: WallWidget;
}

function movement(move: WeekMove | null | undefined): MetricMovement | undefined {
  return move ? { label: formatInt(Math.abs(move.by)), basis: "vs a week ago", direction: move.direction, tone: move.verdict === "good" ? "positive" : move.verdict === "bad" ? "negative" : "neutral" } : undefined;
}

export function WallWork({ assets, operator, nowMs, widget }: WallWorkProps) {
  const observed = assets.flatMap(asset => asset.work ?? []);
  const partial = observed.length < assets.length;
  const weeks = sumWorkWeeks(observed.map(work => work.weeks));
  const waiting = operatorWaiting(operator, nowMs);
  const waitingValue = waiting && (waiting.count > 0 || (!waiting.partial && !waiting.stale)) ? formatInt(waiting.count) : null;
  const waitingNote = [
    waiting?.urgent ? `${waiting.partial ? "at least " : ""}${waiting.urgent} urgent` : null,
    !waiting ? "not read" : waiting.partial ? "Some projects unread" : waiting.stale ? "Snapshot stale" : null,
  ].filter(Boolean).join(" · ");
  const history = (data: NonNullable<typeof weeks>["blocked"]["history"]) => data?.length ? { data, startLabel: "7 days ago", endLabel: "Today" } : undefined;
  const counts = observed.length ? observed.reduce((sum, work) => ({
    open: sum.open + work.open, inProgress: sum.inProgress + work.inProgress, blocked: sum.blocked + work.blocked,
  }), { open: 0, inProgress: 0, blocked: 0 }) : null;
  const inProgress = counts?.inProgress ?? null;
  const blocked = counts?.blocked ?? null;
  const availableCount = (value: number | null) => value === null || (partial && value === 0) ? null : formatInt(value);
  const qualifier = (value: number | null) => partial && value !== null && value > 0 ? "At least" : undefined;
  const stale = observed.some(work => isAmber(nowMs, work.capturedAt, WORK_POLL_CADENCE_HOURS));
  const complete = !partial && !stale;
  const doneMovement = complete ? movement(weeks?.done.move) : undefined;
  const inProgressHistory = history(!partial && !stale && weeks?.inProgress.now === inProgress ? weeks?.inProgress.history : undefined);
  const blockedHistory = history(!partial && !stale && weeks?.blocked.now === blocked ? weeks?.blocked.history : undefined);
  if (!observed.length && waiting === null) return <section aria-label="Work this week" data-wall-work="none" data-material-condition="human-gates" className="flex items-center gap-3 text-wall-body text-muted-foreground"><ListTodo className="size-5 shrink-0" aria-hidden />Tasks unknown</section>;
  const metrics: Partial<Record<WallMetricSource, ReactNode>> = {
    "decisions": <div data-material-condition="human-gates" data-wall-decisions={waiting && waiting.count > 0 ? "waiting" : undefined}>
      <NumberMetric icon={Hand} title="Your decisions" context="All projects" value={waitingValue} qualifier={waitingValue !== null && waiting?.partial ? "At least" : undefined} note={waitingNote || undefined} />
    </div>,
    "task-status": <MetricTile icon={ChartBar} title="Task status" context="Selected assets"><WorkStatus counts={counts} partial={partial} /></MetricTile>,
    "in-progress": <NumberMetric icon={LoaderCircle} title="In progress" value={availableCount(inProgress)} qualifier={qualifier(inProgress)} movement={!partial && !stale ? movement(weekMove("inProgress", inProgress, weeks?.inProgress.before ?? null)) : undefined} history={inProgressHistory} note={!partial && !inProgressHistory ? "History unavailable" : undefined} />,
    "blocked": <NumberMetric icon={Ban} title="Blocked" value={availableCount(blocked)} qualifier={qualifier(blocked)} movement={!partial && !stale ? movement(weekMove("blocked", blocked, weeks?.blocked.before ?? null)) : undefined} history={blockedHistory} note={!partial && !blockedHistory ? "History unavailable" : undefined} />,
    "done": <CumulativeCompareMetric icon={CircleCheck} title="Done this week" context="Selected assets" value={availableCount(weeks?.done.now ?? null)} qualifier={qualifier(weeks?.done.now ?? null)} movement={doneMovement ? { ...doneMovement, basis: "vs last week by today" } : undefined} chartProps={complete ? { variant: "daily-bars-line", current: weeks?.done.history ?? [], domain: weeks ? { start: weeks.weekStart, end: shiftRevenueDate(weeks.weekStart, 6) } : undefined, previousTotal: weeks?.done.lastWeek != null ? { value: weeks.done.lastWeek, label: `Last week total · ${formatInt(weeks.done.lastWeek)}` } : undefined, startLabel: "Monday", endLabel: "Sunday", tone: "positive" } : undefined} chartUnavailable={complete ? undefined : "Comparison unavailable"} />,
  };
  const tiles = wallMetricTiles(widget ?? { id: "work", type: "work", width: 1 });
  const configured = widget?.settings?.metrics !== undefined;
  return <section aria-label="Work this week" data-wall-work className="wall-work">
    <header className="wall-row-heading wall-work-heading"><ListTodo className="size-5 text-muted-foreground" aria-hidden /><h2 className="wall-row-title">Work this week</h2>{stale ? <span className="wall-work-context">Snapshot stale</span> : null}</header>
    <div data-metrics-configured={configured || undefined} style={configured ? { "--wall-metric-tracks": tiles.map(tile => `minmax(0, ${tile.size === "narrow" ? .65 : tile.size === "wide" ? 1.8 : 1}fr)`).join(" ") } as CSSProperties : undefined} className="wall-work-band">
      {tiles.map(tile => <WallMetricBinding key={tile.id} tile={tile} configured={configured}>{configured ? <div data-wall-metric-cell>{metrics[tile.source]}</div> : metrics[tile.source]}</WallMetricBinding>)}
    </div>
  </section>;
}
