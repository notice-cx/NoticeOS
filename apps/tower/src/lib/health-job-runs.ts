// Scheduled runs use explicit UTC calendar days, independent of rich detail.
import { cronIntervalMinutes, scheduleLabel, scheduleTimezone } from "@shared/scheduled-jobs";
import { installedWorkflows, workflowBasePath, type WorkflowsPayload } from "@shared/workflows";

/** How many runs the read keeps per job: a full list may have older ones cut. */
export const KEPT_RUNS = 30;

export type RunDayState =
  /** Every run that day finished, at least one ran. */
  | "ran"
  /** At least one run failed. */
  | "failed"
  /** Every run that day was skipped. */
  | "skipped"
  /** A whole past day with no run, for a job scheduled at least daily. */
  | "missed"
  /** No run, and none was owed: a weekly job's off day, a paused job, the
   * part of today still ahead, or a day before the job first ran. */
  | "none"
  /** Before the oldest run the read kept: not known either way. */
  | "not-kept"
  | "unknown";

export interface RunDay {
  /** `YYYY-MM-DD` in UTC. */
  date: string;
  state: RunDayState;
  ran: number;
  failed: number;
  skipped: number;
  /** The run a press opens: the day's failure, or its newest run. */
  runId: string | null;
  today: boolean;
  /** The kept runs start part-way through this day, so its counts are short. */
  partial: boolean;
}

export interface JobRunRow {
  id: string;
  label: string;
  /** The job's schedule in the reader's words: "Daily at 04:00". */
  schedule: string;
  href: string;
  days: RunDay[];
  paused: boolean;
  /** Runs older than the kept thirty may exist and are not on the page. */
  truncated: boolean;
}

export interface JobRunWeek {
  days: string[];
  rows: JobRunRow[];
}

const pad = (value: number) => String(value).padStart(2, "0");

/** A calendar day in UTC. */
export function localDate(ms: number): string {
  const at = new Date(ms);
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/** The UTC midnight `offset` days from the day `ms` falls on. */
function midnight(ms: number, offset = 0): number {
  const at = new Date(ms);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + offset);
}

export function jobRunWeek(data: WorkflowsPayload, nowMs: number, span = 7): JobRunWeek {
  const starts = Array.from({ length: span }, (_, index) => midnight(nowMs, index - (span - 1)));
  const days = starts.map(localDate);
  const rows = installedWorkflows(data)
    .filter((definition) => definition.surface === "system")
    .map((definition): JobRunRow => {
      const summary = data.workflows.find((workflow) => workflow.id === definition.id);
      const runs = summary?.runs ?? [];
      const job = data.runtime?.jobs.find((entry) => entry.id === definition.id);
      const cron = job?.cron ?? definition.cron;
      const paused = job ? !job.enabled : false;
      const interval = cronIntervalMinutes(cron);
      const owesDaily = !paused && interval !== null && interval <= 24 * 60;
      const daily = summary?.dailyHistory;
      const truncated = !daily && runs.length >= KEPT_RUNS;
      const oldest = daily ? (daily.firstRunAt ? Date.parse(daily.firstRunAt) : null) : runs.length > 0 ? Math.min(...runs.map((run) => Date.parse(run.startedAt))) : null;
      return {
        id: definition.id,
        label: definition.label,
        schedule: scheduleLabel(cron, job ? scheduleTimezone(job) : "UTC", nowMs),
        href: `${workflowBasePath(definition.surface)}/${definition.id}`,
        paused,
        truncated,
        days: starts.map((start, index): RunDay => {
          const end = starts[index + 1] ?? midnight(nowMs, 1);
          const date = days[index]!;
          const today = index === span - 1;
          if (daily || !data.historyAvailable) {
            const bucket = daily?.buckets.find(bucket => Date.parse(bucket.at) === start);
            const covered = data.historyAvailable && daily?.timeZone === 'UTC' && bucket !== undefined
              && Date.parse(daily.from) <= start && Date.parse(daily.through) >= Math.min(end, Date.parse(data.generatedAt));
            const ran = bucket?.succeeded ?? 0, failed = bucket?.failed ?? 0, skipped = bucket?.skipped ?? 0;
            const base = { date, ran, failed, skipped, runId: bucket?.runId ?? null, today, partial: !covered };
            if (failed > 0) return { ...base, state: 'failed' };
            if (!covered || (bucket?.unknown ?? 0) > 0) return { ...base, state: 'unknown' };
            if (ran > 0) return { ...base, state: 'ran' };
            if (skipped > 0) return { ...base, state: 'skipped' };
            const owed = owesDaily && !today && oldest !== null && start > oldest;
            return { ...base, state: owed ? 'missed' : 'none' };
          }
          const own = runs.filter((run) => {
            const at = Date.parse(run.startedAt);
            return at >= start && at < end;
          });
          const count = (state: string) => own.filter((run) => run.state === state).length;
          const ran = count("succeeded");
          const failed = count("failed");
          const skipped = count("skipped");
          const failure = own.find((run) => run.state === "failed");
          const newest = own.reduce<(typeof own)[number] | null>((best, run) => (best === null || run.startedAt > best.startedAt ? run : best), null);
          const runId = failure?.id ?? newest?.id ?? null;
          const partial = truncated && oldest !== null && oldest >= start && oldest < end;
          const base = { date, ran, failed, skipped, runId, today, partial };
          if (failed > 0) return { ...base, state: "failed" };
          if (ran > 0) return { ...base, state: "ran" };
          if (skipped > 0) return { ...base, state: "skipped" };
          if (truncated && oldest !== null && end <= oldest) return { ...base, state: "not-kept" };
          // Before a job's first run in the read's thirty days it may not have
          // existed yet; only a gap after it is a day it should have run.
          const owed = owesDaily && !today && oldest !== null && start > oldest;
          return { ...base, state: owed ? "missed" : "none" };
        }),
      };
    });
  return { days, rows };
}

export interface RunWeekTally {
  runs: number;
  failed: number;
  /** Job-days with at least one failure. */
  failedDays: number;
  missed: number;
  unknownDays: number;
  /** The newest failed day, the one the header names first. */
  latestFailure: { row: JobRunRow; day: RunDay } | null;
}

export function runWeekTally(week: JobRunWeek): RunWeekTally {
  let runs = 0;
  let failed = 0;
  let failedDays = 0;
  let missed = 0;
  let unknownDays = 0;
  let latestFailure: RunWeekTally["latestFailure"] = null;
  for (const row of week.rows) {
    for (const day of row.days) {
      runs += day.ran + day.failed + day.skipped;
      failed += day.failed;
      if (day.partial || day.state === "unknown" || day.state === "not-kept") unknownDays += 1;
      if (day.state === "missed") missed += 1;
      if (day.state === "failed") failedDays += 1;
      if (day.state === "failed" && (latestFailure === null || day.date > latestFailure.day.date)) latestFailure = { row, day };
    }
  }
  return { runs, failed, failedDays, missed, unknownDays, latestFailure };
}
