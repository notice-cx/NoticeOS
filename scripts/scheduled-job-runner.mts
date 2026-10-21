// The local runner's schedule: one timer per enabled job, re-armed from the
// saved schedules the config store holds. Node-only.
//
// Authored TypeScript: `pnpm generate` writes the
// `.mjs` the local runner imports and the `.d.mts` the Tower's Vite lane reads.

import { Cron } from 'croner';
import { configStoreRequest, CONFIG_DOCUMENTS_PATH } from './config-store-client.mjs';
import { SCHEDULED_JOBS, SCHEDULES_FILE, SCHEDULES_HELD, SCHEDULES_WAITING, scheduleFor, scheduleTimezone, schedulesRefusal } from './scheduled-jobs.mjs';
import type { JobSchedule, ScheduleOverrides, ScheduleStatus, ScheduledJob } from './scheduled-jobs.mjs';

/** A store answer as this reader probes it: any shape, every key guarded. */
type Probe = { readonly [key: string]: unknown } | null | undefined;
type Row = { readonly [key: string]: unknown };

export interface ScheduledTimer { stop(): void; nextRun(): Date | null }
export interface ScheduledJobRunner {
  snapshot(): ScheduleStatus;
  apply(overrides: ScheduleOverrides | null): void;
  current(id: string): JobSchedule | null;
  runOnce(id: string, options?: { manual?: boolean; wait?: boolean; execute?: () => Promise<unknown> }): Promise<JobInvocation>;
  refresh(): Promise<void>;
  stop(): void;
}

export type JobInvocation = { status: 'ran'; result: unknown } | { status: 'busy' | 'paused' | 'unavailable' | 'unknown' };

export async function readStoredSchedules(request: typeof configStoreRequest = configStoreRequest): Promise<ScheduleOverrides | null> {
  const result = await request(CONFIG_DOCUMENTS_PATH, {
    params: { bodies: '1' },
    fetchImpl: (url: string | URL | Request, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(5_000) }),
  });
  const document = ((result.body as Probe)?.documents as Probe[] | undefined)?.find((row) => row!.file === SCHEDULES_FILE);
  if (result.status !== 200 || !(result.body as Probe)?.ready || !document?.body) {
    throw new Error('Saved schedules could not be read.');
  }
  const overrides = (document.body as Row).schedules as ScheduleOverrides | undefined ?? null;
  const refusal = schedulesRefusal(overrides ?? {});
  if (refusal) throw new Error(refusal);
  return overrides;
}

/** Replace only changed timers. Callbacks from stopped timers and overlapping
 * invocations cannot fire a job a second time. A read failure keeps the last
 * acknowledged schedule; a first read failure arms nothing. */
export function createScheduledJobRunner({
  jobs = SCHEDULED_JOBS,
  run,
  read = readStoredSchedules,
  publish = async () => {},
  onReady = () => {},
  createTimer = (cron, callback, timezone) => new Cron(cron, { timezone }, callback),
  now = () => new Date(),
}: {
  jobs?: ScheduledJob[];
  run: (job: ScheduledJob, manual?: boolean) => Promise<unknown>;
  read?: () => Promise<ScheduleOverrides | null>;
  publish?: (status: ScheduleStatus) => Promise<void>;
  onReady?: () => void;
  createTimer?: (cron: string, callback: () => Promise<void>, timezone: string) => ScheduledTimer;
  now?: () => Date;
}): ScheduledJobRunner {
  const active = new Map<string, { schedule: JobSchedule; timer: ScheduledTimer | null }>();
  const inFlight = new Map<string, Promise<void>>();
  let refreshing: Promise<void> | null = null;
  let stopped = false;
  let error: string | null = null;
  let initialized = false;

  async function runOnce(id: string, { manual = false, wait = false, execute }: { manual?: boolean; wait?: boolean; execute?: () => Promise<unknown> } = {}): Promise<JobInvocation> {
    const job = jobs.find((candidate) => candidate.id === id);
    if (!job) return { status: 'unknown' };
    if (stopped || !active.has(id) || (manual && error)) return { status: 'unavailable' };
    if (!active.get(id)!.schedule.enabled) return { status: 'paused' };
    if (inFlight.has(id)) {
      if (!wait) return { status: 'busy' };
      // Recovery must outlast a regular tick's held-record bookkeeping.
      // Manual requests never wait for another invocation.
      await inFlight.get(id);
      return runOnce(id, { manual, wait, execute });
    }
    let release!: () => void;
    inFlight.set(id, new Promise<void>((resolve) => { release = resolve; }));
    try { return { status: 'ran', result: await (execute ? execute() : run(job, manual)) }; }
    finally { inFlight.delete(id); release(); }
  }

  function snapshot(): ScheduleStatus {
    return {
      updatedAt: now().toISOString(),
      error,
      jobs: [...active].map(([id, entry]) => ({
        id, ...entry.schedule, nextRun: entry.timer?.nextRun()?.toISOString() ?? null,
      })),
    };
  }

  function apply(overrides: ScheduleOverrides | null) {
    const refusal = schedulesRefusal(overrides ?? {});
    if (refusal) throw new Error(refusal);
    for (const job of jobs) {
      const schedule = scheduleFor(job, overrides ?? {});
      const previous = active.get(job.id);
      if (previous?.schedule.enabled === schedule.enabled && previous.schedule.cron === schedule.cron && scheduleTimezone(previous.schedule) === scheduleTimezone(schedule)) continue;
      const entry: { schedule: JobSchedule; timer: ScheduledTimer | null } = { schedule: { ...schedule }, timer: null };
      // The identity check also rejects a callback already queued by the old timer.
      if (schedule.enabled) {
        entry.timer = createTimer(schedule.cron, async () => {
          if (active.get(job.id) !== entry) return;
          await runOnce(job.id);
        }, scheduleTimezone(schedule));
      }
      previous?.timer?.stop();
      active.set(job.id, entry);
    }
  }

  return {
    snapshot,
    apply,
    current(id: string) { return active.get(id)?.schedule ?? null; },
    runOnce,
    async refresh() {
      if (stopped) return;
      if (refreshing) return refreshing;
      refreshing = (async () => {
        try {
          const overrides = await read();
          if (stopped) return;
          apply(overrides);
          error = null;
          if (!initialized) {
            initialized = true;
            onReady();
          }
        } catch {
          // A state code, not a sentence (`ScheduleReadFailure`): the Tower
          // names it where the operator reads the scheduler's health.
          error = active.size ? SCHEDULES_HELD : SCHEDULES_WAITING;
        }
        if (!stopped) await publish(snapshot());
      })();
      try { await refreshing; } finally { refreshing = null; }
    },
    stop() {
      stopped = true;
      for (const entry of active.values()) entry.timer?.stop();
      active.clear();
    },
  };
}
