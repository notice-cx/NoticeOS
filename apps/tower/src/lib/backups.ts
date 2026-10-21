// Every backup surface judges the newest good copy against the same schedule.
import { Cron } from "croner";
import { ageMs, formatAge } from "@shared/freshness";
import { scheduleTimezone, type JobSchedule } from "@shared/scheduled-jobs";
import type { ScheduledLane } from "@shared/wall";

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
