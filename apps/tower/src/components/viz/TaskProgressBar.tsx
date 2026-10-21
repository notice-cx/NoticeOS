import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Where one task stands on its project's bar. `waiting` is open work held by
 * another task; `unknown` is a task the project counts and the read does not
 * place. */
export type TaskBarState = "done" | "in-progress" | "needs-you" | "blocked" | "ready" | "waiting" | "parked" | "unknown";

export interface TaskBarSegment {
  state: TaskBarState;
}

/** The order a bar fills in, left to right: what is finished, what is moving,
 * what waits on the operator, what is held, what can start, what is set aside. */
export const TASK_BAR_ORDER: readonly TaskBarState[] = ["done", "in-progress", "needs-you", "blocked", "ready", "waiting", "parked", "unknown"];

const WORDS: Record<TaskBarState, { one: string; many: string }> = {
  done: { one: "done", many: "done" },
  "in-progress": { one: "in progress", many: "in progress" },
  "needs-you": { one: "needs you", many: "need you" },
  blocked: { one: "blocked", many: "blocked" },
  ready: { one: "ready", many: "ready" },
  waiting: { one: "waiting", many: "waiting" },
  parked: { one: "parked", many: "parked" },
  unknown: { one: "unknown", many: "unknown" },
};

/** Ready and waiting are the empty track; parked and unknown are hatched,
 * because nothing is moving there and nothing was measured. */
const FILL: Record<TaskBarState, string> = {
  done: "bg-foreground/80",
  "in-progress": "bg-viz-track",
  "needs-you": "border-[1.5px] border-warn bg-transparent",
  blocked: "bg-warn",
  ready: "bg-viz-track",
  waiting: "bg-viz-track",
  parked: "viz-hatch bg-viz-track text-muted-foreground",
  unknown: "viz-hatch bg-viz-track text-muted-foreground",
};

/** Past this many tasks one segment each is too thin to count; the bar draws
 * one run per state, each as wide as its count. */
const SEGMENTS_DRAWN = 40;

const HEIGHT = { sm: "h-1.5", md: "h-2" } as const;

/** The bar's sentence: "9 tasks: 6 done, 1 needs you, 2 blocked". */
export function taskBarLabel(segments: readonly TaskBarSegment[]): string {
  const counts = tally(segments);
  const parts = TASK_BAR_ORDER.flatMap((state) => {
    const n = counts.get(state) ?? 0;
    return n > 0 ? [`${formatInt(n)} ${n === 1 ? WORDS[state].one : WORDS[state].many}`] : [];
  });
  const total = segments.length;
  const head = `${formatInt(total)} ${total === 1 ? "task" : "tasks"}`;
  return parts.length > 0 ? `${head}: ${parts.join(", ")}` : head;
}

function tally(segments: readonly TaskBarSegment[]): Map<TaskBarState, number> {
  const counts = new Map<TaskBarState, number>();
  for (const segment of segments) counts.set(segment.state, (counts.get(segment.state) ?? 0) + 1);
  return counts;
}

/**
 * A project's tasks as one row of equal segments, one per task, filled from
 * the left as the work finishes: done in ink, in progress half filled, a task
 * waiting on the operator outlined in warn, a blocked one filled in warn,
 * what can start as the empty track, parked and unplaced work hatched. The
 * counts are the bar's accessible sentence.
 */
export function TaskProgressBar({ segments, size = "md", className }: {
  segments: readonly TaskBarSegment[];
  size?: "sm" | "md";
  className?: string;
}) {
  const label = taskBarLabel(segments);
  const order = new Map(TASK_BAR_ORDER.map((state, index) => [state, index]));
  const sorted = [...segments].sort((a, b) => order.get(a.state)! - order.get(b.state)!);
  const runs = sorted.length > SEGMENTS_DRAWN
    ? TASK_BAR_ORDER.flatMap((state) => {
      const n = tally(sorted).get(state) ?? 0;
      return n > 0 ? [{ state, grow: n }] : [];
    })
    : sorted.map((segment) => ({ state: segment.state, grow: 1 }));
  return (
    <div
      role="img"
      aria-label={label}
      title={label}
      className={cn("flex w-full gap-[3px]", HEIGHT[size], className)}
      data-task-progress-bar={segments.length}
    >
      {runs.length === 0 ? <span className="h-full flex-1 rounded-sm bg-viz-track" data-state="empty" /> : null}
      {runs.map((run, index) => (
        <span
          key={index}
          data-state={run.state}
          className={cn("relative box-border h-full min-w-[2px] overflow-hidden rounded-sm", FILL[run.state])}
          style={{ flexGrow: run.grow, flexBasis: 0 }}
        >
          {run.state === "in-progress" ? <span aria-hidden className="absolute inset-y-0 left-0 w-1/2 bg-foreground/80" /> : null}
        </span>
      ))}
    </div>
  );
}
