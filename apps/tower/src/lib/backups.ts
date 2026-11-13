// Every backup surface judges the newest good copy against the same schedule.
import { Cron } from "croner";
import { ageMs, formatAge } from "@shared/freshness";
import { scheduleTimezone, type JobSchedule } from "@shared/scheduled-jobs";
import type { ScheduledLane } from "@shared/wall";
import { D1_FAILURE_LABELS } from "@noticeos/contract/cloudflare-d1";
import { isBackupFailure, type BackupFailure } from "../../../../packages/contract/src/backup-evidence.mjs";

/** Missed scheduled opportunities before backups count as failing. */
export const BACKUP_FAILING_RUNS = 2;

export type BackupState = "none" | "off" | "working" | "missed" | "failing";

export interface BackupStatus {
  state: BackupState;
  /** The newest good copy; null when none is on record. */
  lastGoodAt: string | null;
  /** The first missed opportunity or recorded failure after the good copy. */
  failingSince: string | null;
  /** At least this many misses; schedule inference stops at the failing threshold. */
  missedRuns: number;
}

export function isBackupLane(lane: Pick<ScheduledLane, "job">): boolean {
  return /backup/i.test(lane.job);
}

/** Missing history cannot establish a missed firing. Recorded failures still
 * count without a good copy or a schedule (including older payloads). */
export function backupStatus(lanes: readonly ScheduledLane[], nowMs: number, schedule?: JobSchedule, lastGoodAt?: string | null): BackupStatus {
  const histories = lanes.filter(isBackupLane).map((lane) => {
    if (lane.job !== "backup" || !lastGoodAt || (lane.lastRanAt !== null && lane.lastRanAt >= lastGoodAt)) return lane;
    return { ...lane, lastRanAt: lastGoodAt, failedRuns: 0, failingSince: null };
  });
  const copies: Pick<ScheduledLane, "lastRanAt" | "failedRuns" | "failingSince">[] = [...histories];
  if (lastGoodAt && !histories.some((lane) => lane.job === "backup")) {
    copies.push({ lastRanAt: lastGoodAt, failedRuns: 0, failingSince: null });
  }
  const statuses = copies.map((lane): BackupStatus => {
    let missedRuns = lane.failedRuns;
    let failingSince = lane.failingSince;
    if (schedule?.enabled && lane.lastRanAt !== null && Number.isFinite(Date.parse(lane.lastRanAt))) {
      const timer = new Cron(schedule.cron, { timezone: scheduleTimezone(schedule), paused: true });
      try {
        // Only two opportunities are needed to determine health, even after
        // years offline with an every-minute schedule. A good copy at a tick
        // satisfies that tick; only strictly later opportunities are owed.
        const due = timer.nextRuns(BACKUP_FAILING_RUNS, new Date(lane.lastRanAt))
          .filter((at) => at.getTime() <= nowMs);
        missedRuns = Math.max(missedRuns, due.length);
        const first = due[0]?.toISOString();
        if (first && (failingSince === null || first < failingSince)) failingSince = first;
      } finally {
        timer.stop();
      }
    }
    return {
      state: missedRuns >= BACKUP_FAILING_RUNS ? "failing" : missedRuns > 0 ? "missed" : lane.lastRanAt === null ? "none" : "working",
      lastGoodAt: lane.lastRanAt, failingSince, missedRuns,
    };
  });
  const worst = statuses.sort((a, b) => b.missedRuns - a.missedRuns || (a.lastGoodAt ?? "").localeCompare(b.lastGoodAt ?? ""))[0]
    ?? { state: "none", lastGoodAt: null, failingSince: null, missedRuns: 0 };
  return schedule?.enabled === false ? { ...worst, state: "off", failingSince: null, missedRuns: 0 } : worst;
}

/** "last good copy 12d ago", or "no good copy yet". */
export function lastGoodCopy(status: Pick<BackupStatus, "lastGoodAt">, nowMs: number): string {
  const age = ageMs(nowMs, status.lastGoodAt);
  return age === null ? "no good copy yet" : `last good copy ${formatAge(age)} ago`;
}

const FAILED_PARTS: Record<BackupFailure["stage"], string> = {
  preparation: "Backup preparation", postgres: "Operational database", r2: "Stored files", taskHub: "Tasks",
  assets: "Asset databases", history: "Analytical history", recovery: "Recovery credentials",
  instructions: "Restore instructions", publication: "Save to this installation", offsite: "Offsite copy",
  retention: "Backup retention", cleanup: "Backup cleanup",
};

export function backupFailureLine(lanes: readonly ScheduledLane[], status: BackupStatus): string | undefined {
  if (status.state !== "missed" && status.state !== "failing") return;
  const latest = lanes.filter(isBackupLane).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (latest?.outcome !== "failed" || status.lastGoodAt !== null && status.lastGoodAt >= latest.startedAt
    || !isBackupFailure(latest.backupFailure)) return;
  const { stage, cause } = latest.backupFailure;
  if (cause === "stage_failed") return `${FAILED_PARTS[stage]} failed`;
  if (cause === "worker_unavailable") return "Backup worker unavailable";
  if (cause === "worker_busy") return "A previous backup is still in progress";
  if (cause === "worker_timeout") return "Backup worker did not finish in time";
  if (cause.startsWith("d1_http_")) return `Cloudflare check returned HTTP ${cause.slice(8)}`;
  if (cause === "d1_unreachable") return "Cloudflare backup check could not reach NoticeOS";
  const token = cause.slice(3) as keyof typeof D1_FAILURE_LABELS;
  return `Cloudflare database backup · ${D1_FAILURE_LABELS[token]}`;
}
