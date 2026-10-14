// The backup lane as `readLatestJobRuns` reads it, at the default nightly
// 04:00 UTC schedule, for the tests of every surface that judges backups.
import type { ScheduledLane } from "@shared/wall";

const DAY_MS = 86_400_000;

/** The scheduled backup `nightsAgo` nights before the latest one at or before `nowMs`. */
export function backupNight(nowMs: number, nightsAgo: number): string {
  const today = new Date(nowMs);
  today.setUTCHours(4, 0, 0, 0);
  const latest = today.getTime() <= nowMs ? today.getTime() : today.getTime() - DAY_MS;
  return new Date(latest - nightsAgo * DAY_MS).toISOString();
}

/** `failedNights` failed scheduled nights, the latest one last, after the
 * good copy `lastGood` (null: none on record). */
export function backupLane(nowMs: number, failedNights: number, lastGood: string | null): ScheduledLane {
  return {
    job: "backup",
    outcome: failedNights > 0 ? "failed" : "ran",
    startedAt: backupNight(nowMs, 0),
    lastRanAt: lastGood,
    failedRuns: failedNights,
    failingSince: failedNights > 0 ? backupNight(nowMs, failedNights - 1) : null,
  };
}

/** Failed scheduled nights followed by a pressed backup that ran: the latest
 * scheduled firing still failed, and nothing has failed since the press. */
export function pressedBackupLane(nowMs: number, pressedAt: string): ScheduledLane {
  return { job: "backup", outcome: "failed", startedAt: backupNight(nowMs, 0), lastRanAt: pressedAt, failedRuns: 0, failingSince: null };
}
