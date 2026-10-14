// The backup lanes read once for every surface that shows them (Home's grid,
// System health, Settings, Needs you): how old the newest good copy is, and how
// many scheduled backups have failed since it. A backup is judged from its last
// good copy, never from its latest run alone, so twelve failed nights read as
// twelve and a pressed backup that ran clears them.
import { ageMs, formatAge } from "@shared/freshness";
import type { ScheduledLane } from "@shared/wall";

/** Scheduled backups failed since the last good copy before backups count as
 * failing (red, and one Needs you row). Counted in runs, not hours, so a
 * changed schedule keeps the rule. One failed run is amber. */
export const BACKUP_FAILING_RUNS = 2;

/** `none`: no good copy and no failure on record; `missed`: one scheduled
 * backup failed since the last good copy; `failing`: two or more. */
export type BackupState = "none" | "working" | "missed" | "failing";

export interface BackupStatus {
  state: BackupState;
  /** The newest good copy; null when none is on record. */
  lastGoodAt: string | null;
  /** The first scheduled backup that failed after it; null when none has. */
  failingSince: string | null;
  failedRuns: number;
}

export function isBackupLane(lane: Pick<ScheduledLane, "job">): boolean {
  return /backup/i.test(lane.job);
}

/** The worst backup lane's status: the most failed runs, then the oldest good copy. */
export function backupStatus(lanes: readonly ScheduledLane[]): BackupStatus {
  const worst = lanes
    .filter(isBackupLane)
    .sort((a, b) => b.failedRuns - a.failedRuns || (a.lastRanAt ?? "").localeCompare(b.lastRanAt ?? ""))[0];
  if (!worst) return { state: "none", lastGoodAt: null, failingSince: null, failedRuns: 0 };
  const state: BackupState =
    worst.failedRuns >= BACKUP_FAILING_RUNS ? "failing" : worst.failedRuns > 0 ? "missed" : worst.lastRanAt === null ? "none" : "working";
  return { state, lastGoodAt: worst.lastRanAt, failingSince: worst.failingSince, failedRuns: worst.failedRuns };
}

/** "last good copy 12d ago", or "no good copy yet". */
export function lastGoodCopy(status: Pick<BackupStatus, "lastGoodAt">, nowMs: number): string {
  const age = ageMs(nowMs, status.lastGoodAt);
  return age === null ? "no good copy yet" : `last good copy ${formatAge(age)} ago`;
}
