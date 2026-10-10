import { CRON_RUN_SILENCE_MS } from "@noticeos/contract/job-runs";
import {
  CheckCircle2,
  CircleHelp,
  CirclePause,
  ClockAlert,
  XCircle,
} from "lucide-react";
import { SCHEDULED_JOBS, jobRunName } from "@shared/scheduled-jobs";
import type { ScheduledLane, Severity } from "@shared/wall";
import { ageMs, formatAge } from "@shared/freshness";
import { cn } from "@/lib/utils";

export type ScheduledLanePosture =
  | "healthy"
  | "skipped"
  | "failed"
  | "silent"
  | "unknown";

function laneLabel(job: string): string {
  return SCHEDULED_JOBS.find((candidate) => jobRunName(candidate) === job)?.label ?? job;
}

export function scheduledLanePosture(
  lanes: ScheduledLane[],
  nowMs: number,
): ScheduledLanePosture {
  if (lanes.length === 0) return "unknown";
  if (lanes.some((lane) => lane.outcome === "failed")) return "failed";
  const freshest = Math.max(...lanes.map((lane) => Date.parse(lane.startedAt)));
  if (!Number.isFinite(freshest) || freshest < nowMs - CRON_RUN_SILENCE_MS) {
    return "silent";
  }
  if (lanes.some((lane) => lane.outcome === "skipped")) return "skipped";
  return "healthy";
}

export function scheduledLaneSeverity(
  lanes: ScheduledLane[],
  nowMs: number,
): Severity | null {
  const posture = scheduledLanePosture(lanes, nowMs);
  if (posture === "failed" || posture === "silent") return "error";
  if (posture === "skipped" || posture === "unknown") return "warn";
  return null;
}

export function scheduledLaneHeadline(
  lanes: ScheduledLane[],
  nowMs: number,
): string {
  const posture = scheduledLanePosture(lanes, nowMs);
  if (posture === "unknown") return "Scheduled runs not yet recorded";
  const failed = lanes.filter((lane) => lane.outcome === "failed").length;
  const skipped = lanes.filter((lane) => lane.outcome === "skipped").length;
  const freshest = lanes.reduce(
    (latest, lane) => (lane.startedAt > latest ? lane.startedAt : latest),
    "",
  );
  const oldest = lanes.reduce(
    (earliest, lane) =>
      earliest === "" || lane.startedAt < earliest ? lane.startedAt : earliest,
    "",
  );
  const age = `${formatAge(ageMs(nowMs, freshest))} ago`;
  if (posture === "failed") {
    return `${failed} failed · ${lanes.length} jobs tracked`;
  }
  if (posture === "silent") return `Scheduler silent · last firing ${age}`;
  if (posture === "skipped") {
    return `${skipped} skipped · ${lanes.length} jobs tracked`;
  }
  const oldestAge = formatAge(ageMs(nowMs, oldest));
  const freshestAge = formatAge(ageMs(nowMs, freshest));
  return lanes.length === 1
    ? `1 job · age ${freshestAge}`
    : `${lanes.length} jobs · age ${freshestAge}–${oldestAge}`;
}

function PostureIcon({ posture }: { posture: ScheduledLanePosture }) {
  if (posture === "failed") {
    return <XCircle className="size-4 text-error" aria-hidden />;
  }
  if (posture === "silent") {
    return <ClockAlert className="size-4 text-error" aria-hidden />;
  }
  if (posture === "skipped") {
    return <CirclePause className="size-4 text-warn" aria-hidden />;
  }
  if (posture === "unknown") {
    return <CircleHelp className="size-4 text-warn" aria-hidden />;
  }
  return <CheckCircle2 className="size-4 text-muted-foreground" aria-hidden />;
}

export function ScheduledLanesSummary({
  lanes,
  nowMs,
  className,
}: {
  lanes: ScheduledLane[];
  nowMs: number;
  className?: string;
}) {
  const posture = scheduledLanePosture(lanes, nowMs);
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 text-sm",
        posture === "failed" || posture === "silent"
          ? "font-semibold text-error"
          : posture === "skipped" || posture === "unknown"
            ? "font-semibold text-warn"
            : "text-muted-foreground",
        className,
      )}
      data-scheduled-posture={posture}
      data-material-condition="scheduled-lane-health"
      data-visual-state={posture}
    >
      <PostureIcon posture={posture} />
      <span className="truncate">{scheduledLaneHeadline(lanes, nowMs)}</span>
    </div>
  );
}

const OUTCOME_RANK = { failed: 0, skipped: 1, ran: 2 } as const;

export function ScheduledLanesPanel({
  lanes,
  nowMs,
}: {
  lanes: ScheduledLane[];
  nowMs: number;
}) {
  const panelPosture = scheduledLanePosture(lanes, nowMs);
  const ordered = [...lanes].sort(
    (a, b) =>
      OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome] ||
      a.startedAt.localeCompare(b.startedAt) ||
      laneLabel(a.job).localeCompare(laneLabel(b.job)),
  );
  return (
    <section
      className="rounded-xl border border-border bg-card p-4"
      aria-label="Scheduled automation"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">Scheduled automation</h3>
          <p className="text-sm text-muted-foreground">
            Latest recorded run of each job, including paused jobs
          </p>
        </div>
        {lanes.length > 0 ? (
          <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
            {lanes.length} tracked
          </span>
        ) : null}
      </div>
      <a href="/health/operations" className="mb-3 inline-flex text-sm underline underline-offset-4">View background operations</a>
      {ordered.length === 0 ? (
        // Nothing recorded is unknown, never healthy.
        <div
          className="flex items-center gap-2 rounded-md bg-muted/25 px-4 py-3"
          data-scheduled-empty
          data-lane-posture={panelPosture}
        >
          <PostureIcon posture={panelPosture} />
          <p className="font-medium">{scheduledLaneHeadline(lanes, nowMs)}</p>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {ordered.map((lane) => {
            const failed = lane.outcome === "failed";
            const skipped = lane.outcome === "skipped";
            const lanePosture = failed
              ? "failed"
              : skipped
                ? "skipped"
                : panelPosture === "silent"
                  ? "silent"
                  : "healthy";
            return (
              <div
                className={cn(
                  "grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-3 py-2",
                  failed
                    ? "border-error/50 bg-error/5"
                    : skipped
                      ? "border-warn/45 bg-warn/5"
                      : "border-border bg-background/35",
                )}
                data-scheduled-lane={lane.job}
                data-lane-posture={lanePosture}
                data-outcome={lane.outcome}
                key={lane.job}
                title={`Job id: ${lane.job}`}
              >
                <PostureIcon posture={lanePosture} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {laneLabel(lane.job)}
                  </p>
                  <p
                    className={cn(
                      "text-xs capitalize",
                      lanePosture === "failed" || lanePosture === "silent"
                        ? "text-error"
                        : lanePosture === "skipped"
                          ? "text-warn"
                          : "text-muted-foreground",
                    )}
                  >
                    {lane.outcome}
                  </p>
                </div>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatAge(ageMs(nowMs, lane.startedAt))} ago
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
