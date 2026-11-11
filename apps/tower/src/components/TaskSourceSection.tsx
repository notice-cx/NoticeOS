import { Link } from "react-router-dom";

import {
  TASK_SOURCES_PATH,
  TASK_SNAPSHOTS,
  taskSourceConnection,
  type TaskSourcePayload,
} from "@shared/task-source";
import { EmptyState } from "@/components/EmptyState";
import { StateChip } from "@/components/StateChip";
import { pillControlClass } from "@/components/ui/pill";
import { useNow } from "@/hooks/useNow";
import { useTaskSource } from "@/hooks/useTaskSource";
import { cn } from "@/lib/utils";

// Hub availability never controls whether Tasks exists; reads and writes
// keep their own failures.

export function TaskSourceRows({ payload, nowMs, anchor = "task-source-status" }: {
  payload: TaskSourcePayload;
  nowMs: number;
  anchor?: string;
}) {
  return (
    <section id={anchor} aria-label="Task database" className="flex flex-col gap-2">
      {payload.sources.map((status) => {
        const kind = taskSourceConnection(status, nowMs);
        const label = kind === "not-connected" ? "No projects" : kind === "collecting" ? "Waiting for first read" :
          kind === "overdue" ? "Stale" : kind === "failing" ? "Unavailable" : "Available";
        const tone = kind === "failing" ? "critical" : kind === "overdue" || kind === "not-connected" ? "caution" :
          kind === "working" ? "affirmative" : "na";
        return (
          <div key={status.id} className="flex flex-wrap items-center gap-3" data-task-hub-state={kind}>
            <span className="font-medium">Task database</span>
            <StateChip tone={tone} label={label} subject={`tasks:${status.id}`} />
            <span className="text-sm text-muted-foreground tabular-nums">{status.projects} {status.projects === 1 ? "project" : "projects"}</span>
            {status.failing > 0 && kind !== "failing" ? <span className="text-sm text-warn tabular-nums">{status.failing} unavailable</span> : null}
          </div>
        );
      })}
    </section>
  );
}

/** Status lives beside Task projects in Settings, separate from providers. */
export function TaskSourceSection() {
  const { data, isError } = useTaskSource();
  const now = useNow();
  return data ? <TaskSourceRows payload={data} nowMs={now} /> : (
    <StateChip tone={isError ? "caution" : "na"} label={isError ? "Task database status unavailable" : "Checking task database"} subject={`tasks:${TASK_SNAPSHOTS}`} />
  );
}

/** An installation with no task service connected: its one step to having tasks. */
export function ConnectNtasks() {
  return (
    <div className="rounded-xl border border-border bg-card p-4" data-connect-ntasks>
      <EmptyState
        title="Connect Ntasks"
        hint={
          <span className="flex flex-col items-start gap-2">
            <span>This installation's tasks live in Ntasks. Connect it to plan and track work here.</span>
            <Link
              to={TASK_SOURCES_PATH}
              className={cn(
                "inline-flex items-center font-medium text-foreground underline-offset-4 hover:underline",
                pillControlClass,
              )}
            >
              Go to Task projects →
            </Link>
          </span>
        }
      />
    </div>
  );
}

/**
 * An unread or unconfigured core hub leads to the existing project settings.
 * This is not an empty queue and never hides known tasks.
 */
export function TaskHubUnavailable() {
  return (
    <div className="rounded-xl border border-border bg-card p-4" data-task-hub-unavailable>
      <EmptyState
        title="No task projects available"
        hint={
          <Link
            to={TASK_SOURCES_PATH}
            className={cn(
              "inline-flex items-center font-medium text-foreground underline-offset-4 hover:underline",
              pillControlClass,
            )}
          >
            Manage task projects →
          </Link>
        }
      />
    </div>
  );
}
