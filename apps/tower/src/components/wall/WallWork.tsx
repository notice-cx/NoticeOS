import { CircleCheck, Hand, LoaderCircle, Ban, ListTodo } from "lucide-react";
import type { AssetCard, OperatorPosture } from "@shared/wall";
import { wallMetricTiles, type WallWidget, type WallMetricSource } from "@shared/wall-layout";
import type { CSSProperties, ReactNode } from "react";
import { WallMetricBinding } from "./WallMetricEditing";
import { sumWorkWeeks, weekMove, WORK_POLL_CADENCE_HOURS, type WeekMove } from "@shared/work";
import { isAmber } from "@shared/freshness";
import { operatorWaiting } from "@/lib/operator-posture";
import { shiftRevenueDate } from "@shared/revenue-projection";
import { formatInt } from "@/lib/format";
import { CumulativeCompareMetric, NumberMetric, type MetricMovement } from "./MetricWidgets";

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
  const observed = assets.filter((asset) => asset.work);
  const partial = observed.length < assets.length;
  const weeks = sumWorkWeeks(observed.map((asset) => asset.work!.weeks));
  const waiting = operatorWaiting(operator, nowMs);
  const waitingValue = !waiting || ((waiting.partial || waiting.stale) && waiting.count === 0)
    ? null : formatInt(waiting.count);
  const waitingNote = [
    waiting?.urgent ? `${waiting.partial ? "at least " : ""}${waiting.urgent} urgent` : null,
    !waiting ? "not read" : waiting.partial ? "Some projects unread" : waiting.stale ? "Snapshot stale" : null,
  ].filter(Boolean).join(" · ");
  const waitingComparable = waiting && !waiting.partial && !waiting.stale && operator?.projectCount === observed.length && weeks?.waiting.now === waiting.count;
  const history = (data: NonNullable<typeof weeks>["blocked"]["history"]) => data?.length ? { data, startLabel: "7 days ago", endLabel: "Today" } : undefined;
  const doneMovement = !partial ? movement(weeks?.done.move) : undefined;
  const inProgress = observed.length ? observed.reduce((sum, asset) => sum + asset.work!.inProgress, 0) : null;
  const blocked = observed.length ? observed.reduce((sum, asset) => sum + asset.work!.blocked, 0) : null;
  const availableCount = (value: number | null) => value === null || (partial && value === 0) ? null : formatInt(value);
  const qualifier = (value: number | null) => partial && value !== null && value > 0 ? "At least" : undefined;
  const partialNote = partial ? "Some task counts unavailable" : undefined;
  const stale = observed.some((asset) => isAmber(nowMs, asset.work!.capturedAt, WORK_POLL_CADENCE_HOURS));
  const waitingHistory = history(waitingComparable ? weeks?.waiting.history : undefined);
  const inProgressHistory = history(!partial && !stale && weeks?.inProgress.now === inProgress ? weeks?.inProgress.history : undefined);
  const blockedHistory = history(!partial && !stale && weeks?.blocked.now === blocked ? weeks?.blocked.history : undefined);
  if (!observed.length && waiting === null) return <section aria-label="Work this week" data-wall-work="none" data-material-condition="human-gates" className="flex items-center gap-3 text-wall-body text-muted-foreground"><ListTodo className="size-5 shrink-0" aria-hidden />Tasks unknown</section>;
  const metrics: Partial<Record<WallMetricSource, ReactNode>> = {
    "decisions": <div data-material-condition="human-gates"><NumberMetric icon={Hand} title="Your decisions" value={waitingValue} qualifier={waitingValue !== null && waiting?.partial ? "At least" : undefined} note={[waitingHistory ? null : "History unavailable", waitingNote].filter(Boolean).join(" · ")} movement={waitingComparable ? movement(weeks?.waiting.move) : undefined} history={waitingHistory} /></div>,
    "in-progress": <NumberMetric icon={LoaderCircle} title="In progress" value={availableCount(inProgress)} qualifier={qualifier(inProgress)} movement={!partial && !stale ? movement(weekMove("inProgress", inProgress, weeks?.inProgress.before ?? null)) : undefined} history={inProgressHistory} note={partialNote ?? (!inProgressHistory ? "History unavailable" : undefined)} />,
    "blocked": <NumberMetric icon={Ban} title="Blocked" value={availableCount(blocked)} qualifier={qualifier(blocked)} movement={!partial && !stale ? movement(weekMove("blocked", blocked, weeks?.blocked.before ?? null)) : undefined} history={blockedHistory} note={partialNote ?? (!blockedHistory ? "History unavailable" : undefined)} />,
    "done": <CumulativeCompareMetric icon={CircleCheck} title="Done this week" value={availableCount(weeks?.done.now ?? null)} qualifier={qualifier(weeks?.done.now ?? null)} unit="closed" note={partialNote} movement={doneMovement ? { ...doneMovement, basis: "vs last week by today" } : undefined} chartProps={!partial ? { variant: "daily-bars-line", current: weeks?.done.history ?? [], domain: weeks ? { start: weeks.weekStart, end: shiftRevenueDate(weeks.weekStart, 6) } : undefined, previousTotal: weeks?.done.lastWeek != null ? { value: weeks.done.lastWeek, label: `Last week total · ${formatInt(weeks.done.lastWeek)}` } : undefined, startLabel: "Monday", endLabel: "Sunday" } : undefined} chartUnavailable={partial ? "Comparison unavailable" : undefined} />,
  };
  const tiles = wallMetricTiles(widget ?? { id: "work", type: "work", width: 1 });
  const configured = widget?.settings?.metrics !== undefined;
  return <section aria-label="Work this week" data-wall-work className="@container min-w-0">
    <div data-metrics-configured={configured || undefined} style={configured ? { "--wall-metric-tracks": tiles.map(tile => `minmax(0, ${tile.size === "narrow" ? .65 : tile.size === "wide" ? 1.8 : 1}fr)`).join(" ") } as CSSProperties : undefined} className="wall-work-band grid grid-cols-1 items-start gap-4 @min-[1100px]:grid-cols-[200px_repeat(3,minmax(0,1fr))_minmax(0,1.8fr)]">
      <h2 className="flex h-full flex-col justify-center font-semibold" style={{ fontSize: "var(--text-xl)", lineHeight: 1.25 }}><ListTodo className="mb-2 size-5 text-muted-foreground" aria-hidden />Work this week{weeks?.weekStart ? <span className="mt-1 block text-wall-detail font-normal text-muted-foreground" data-work-days-in={weeks.daysIn}>{weeks.daysIn} {weeks.daysIn === 1 ? "day" : "days"} in</span> : null}{stale ? <span className="block text-wall-detail font-normal text-muted-foreground">Snapshot stale</span> : null}</h2>
      {tiles.map(tile => <WallMetricBinding key={tile.id} tile={tile} configured={configured}>{configured ? <div data-wall-metric-cell>{metrics[tile.source]}</div> : metrics[tile.source]}</WallMetricBinding>)}
    </div>
  </section>;
}
