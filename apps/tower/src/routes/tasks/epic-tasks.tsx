import type { CSSProperties } from "react";
import { claimedModel, taskActorLabel } from "@shared/tasks";
import { Meter } from "@/components/Meter";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatInt } from "@/lib/format";
import type { BoardTask } from "@/lib/task-board-read";
import type { EpicTaskGroup } from "@/lib/task-board-viz";
import { cn } from "@/lib/utils";
import { TaskRow } from "./task-row";

/** An epic's all-time progress: closed of total, as a bar with its figure.
 * With its tasks known, the bar is one segment per task (`EpicSegments`). */
export function EpicProgress({ closed, total, segments, className }: {
  closed: number;
  total: number;
  segments?: readonly EpicSegment[] | null;
  className?: string;
}) {
  const drawn = segments && segments.length > 0 && segments.length <= SEGMENTS_DRAWN ? segments : null;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)} data-epic-progress={`${closed}/${total}`}>
      {drawn ? (
        <EpicSegments segments={drawn} label={`${closed} of ${total} children closed`} closed={closed} total={total} />
      ) : (
        <Meter value={closed} max={total} ariaLabel={`${closed} of ${total} children closed`} className="w-24 shrink-0" />
      )}
      <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        {formatInt(closed)} of {formatInt(total)} closed
      </span>
    </span>
  );
}

/** Past this many tasks a segment is too thin to read; the bar is drawn whole. */
const SEGMENTS_DRAWN = 40;

/** One of an epic's tasks on its progress bar. `earlier` is a task closed
 * before the read's window, known only by the epic's count; `unknown` one the
 * count holds and the read does not, state unknown. */
export interface EpicSegment {
  id: string;
  state: "done" | "active" | "blocked" | "waiting" | "earlier" | "unknown";
  /** The task whose page this is. */
  self?: boolean;
  /** The first task ready to be claimed. */
  next?: boolean;
}

const SEGMENT_ORDER: Record<EpicSegment["state"], number> = { earlier: 0, done: 1, active: 2, blocked: 3, waiting: 4, unknown: 5 };

/**
 * An epic's tasks as segments: every closed one filled, then the work under
 * way, what is held, what waits, and what the read cannot place, so the bar
 * fills from the left as the epic does. The epic's all-time count is the
 * denominator, since a list read is a window.
 */
export function epicSegments({ children, self = null, next = null, closed, total }: {
  children: readonly BoardTask[];
  self?: string | null;
  next?: string | null;
  closed: number;
  total: number;
}): EpicSegment[] {
  const listed = children.map((task): EpicSegment => ({
    id: task.id,
    state: task.status === "closed" ? "done" : task.status === "in_progress" ? "active" : task.status === "blocked" ? "blocked" : "waiting",
    ...(task.id === self ? { self: true } : {}),
    ...(task.id === next ? { next: true } : {}),
  }));
  const listedClosed = listed.filter((segment) => segment.state === "done").length;
  const unlisted = Math.max(0, total - listed.length);
  const earlier = Math.min(unlisted, Math.max(0, closed - listedClosed));
  const rest: EpicSegment[] = [
    ...Array.from({ length: earlier }, (_, i): EpicSegment => ({ id: `earlier-${i}`, state: "earlier" })),
    ...Array.from({ length: unlisted - earlier }, (_, i): EpicSegment => ({ id: `unknown-${i}`, state: "unknown" })),
  ];
  return [...rest, ...listed].sort((a, b) => SEGMENT_ORDER[a.state] - SEGMENT_ORDER[b.state]
    || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

const SEGMENT_FILL: Record<EpicSegment["state"], string> = {
  earlier: "bg-foreground/55",
  done: "bg-foreground/70",
  active: "bg-foreground/30",
  blocked: "bg-warn/70",
  waiting: "bg-viz-track",
  unknown: "viz-hatch bg-viz-track text-muted-foreground",
};

/** The bar, segment by segment: this task ringed, the next ready one marked
 * with the dot the Next ready line starts with. Closed is ink, never green. */
export function EpicSegments({ segments, label, closed, total }: { segments: readonly EpicSegment[]; label: string; closed: number; total: number }) {
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuenow={closed}
      aria-valuemin={0}
      aria-valuemax={total}
      data-epic-segments={segments.length}
      className="flex h-3.5 shrink-0 items-start gap-[2px]"
      // About a rem a segment, between 6 and 11 rem.
      style={{ width: `min(11rem, max(6rem, ${segments.length} * 0.875rem))` }}
    >
      {segments.map((segment, index) => (
        <span
          key={segment.id}
          data-segment={segment.state}
          data-segment-self={segment.self ? "" : undefined}
          data-segment-next={segment.next ? "" : undefined}
          className="relative flex h-full min-w-[3px] flex-1 flex-col items-center"
        >
          <span
            className={cn(
              "viz-grow-y block h-2 w-full rounded-[2px]",
              SEGMENT_FILL[segment.state],
              segment.self && "ring-2 ring-foreground ring-offset-1 ring-offset-card",
            )}
            style={{ "--viz-i": index } as CSSProperties}
          />
          {segment.next ? <span aria-hidden className="mt-[3px] size-1 rounded-full bg-foreground" /> : null}
        </span>
      ))}
    </span>
  );
}

/**
 * Everything an epic holds, grouped by where each task stands in the board's
 * words, each row opening its own page. `missing` names the tasks the epic
 * holds that this read does not list, and why, so a short list never reads as
 * the whole epic.
 */
export function EpicTaskList({
  groups,
  missing,
  graphHref,
  taskHref,
  className,
}: {
  groups: readonly EpicTaskGroup[];
  missing: string | null;
  /** The board's Epic graph with this epic chosen, when the board draws one. */
  graphHref: string | null;
  taskHref: (id: string) => string;
  className?: string;
}) {
  const listed = groups.reduce((sum, group) => sum + group.tasks.length, 0);
  return (
    <Card className={className} data-epic-tasks="">
      <CardHeader className="pb-2">
        <SectionLabel
          title="Tasks"
          caption={listed > 0 ? formatInt(listed) : undefined}
          action={graphHref ? { label: "Epic graph →", to: graphHref } : undefined}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {groups.map((group) => (
          <section key={group.word} aria-label={group.word} data-epic-group={group.word} className="flex min-w-0 flex-col gap-1">
            <h3 className="m-0 flex items-baseline gap-2 text-xs font-medium text-foreground">
              {group.word}
              <span className="tabular-nums text-muted-foreground">{formatInt(group.tasks.length)}</span>
            </h3>
            <ul className="-mx-2 flex flex-col">
              {group.tasks.map((task) => (
                <EpicTaskRow key={task.id} task={task} href={taskHref(task.id)} />
              ))}
            </ul>
          </section>
        ))}
        {missing ? (
          <p className="m-0 text-xs text-muted-foreground" data-epic-missing="">{missing}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function EpicTaskRow({ task, href }: { task: BoardTask; href: string }) {
  const holder = task.assignee ? taskActorLabel(task.assignee, task.actors) : null;
  const model = claimedModel({ metadata: (task as BoardTask & { metadata?: Record<string, unknown> | null }).metadata ?? null });
  return (
    <TaskRow
      task={{ id: task.id, title: task.title, status: task.status, priority: task.priority, holder: holder ? { name: holder, model } : null }}
      href={href}
      marks={{ "data-epic-task": task.id }}
    />
  );
}
