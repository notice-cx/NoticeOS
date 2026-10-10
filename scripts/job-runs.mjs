// The record every scheduled lane leaves, and the recovery it allows after
// downtime. Shared by the managed service's runner (scripts/os-up.mjs) and
// `pnpm start`'s schedule (scripts/start-schedule.mjs). Every effect — the
// file, the clock, the log, the store — is passed in.
//
// Each firing appends one line to `.local/logs/job-runs.jsonl`: which lane,
// when it started, how long it took, and ran / skipped / failed. The grain is
// the lane: a per-item failure inside a lane stays an ERROR line, and `failed`
// means the firing itself came apart.
//
// The file is the record; the `job_runs` table is its mirror. The store is
// served by the very runtime these lanes fire at, so the line hits disk first
// and always; each firing is also shipped through `POST /api/job-runs`, and
// with the door down the record catches up on the next firing that finds it
// open.

import fs from 'node:fs/promises';
import { Cron } from 'croner';
import { SCHEDULED_JOBS, jobRunName, scheduleTimezone } from './scheduled-jobs.mjs';
import { stepResult } from './workflow-trace.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ─── The record ──────────────────────────────────────────────────────────────

/** Long enough for a monthly-cadence question, short enough that the file
 * stays a few megabytes at the busiest lane's one-a-minute. */
export const JOB_RUN_RETENTION_DAYS = 30;

/** What a firing can amount to. `skipped` is a first-class outcome, not a
 * non-event: a lane that stood down every tick for a week is a finding. */
export const JOB_RUN_OUTCOMES = ['ran', 'skipped', 'failed'];

/**
 * One firing, as the record keeps it. `at` is when the firing started and
 * `ms` how long it took, so the finish is derivable. There is no separate
 * "scheduled at": `at` is the tick.
 */
export function jobRunRecord({ job, outcome, detail = null, startedAtMs, finishedAtMs }) {
  const at = new Date(startedAtMs).toISOString();
  const record = {
    at,
    job,
    outcome: JOB_RUN_OUTCOMES.includes(outcome) ? outcome : 'failed',
    ms: Math.max(0, Math.round((finishedAtMs ?? startedAtMs) - startedAtMs)),
  };
  // The detail is often an error message; one runaway stack must not cost the
  // record its readability.
  if (detail) record.detail = String(detail).replace(/\s+/g, ' ').trim().slice(0, 200);
  return record;
}

export function jobRunLine(record) {
  return `${JSON.stringify(record)}\n`;
}

/** Records back from the file. A torn last line is normal (the writer can be
 * SIGKILLed mid-write), so a malformed line is skipped rather than fatal. */
export function parseJobRuns(text) {
  const records = [];
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.job === 'string' && typeof parsed?.at === 'string') records.push(parsed);
    } catch {
      // torn or hand-edited line
    }
  }
  return records;
}

/** Everything at or after the cutoff. Pruned by date rather than line count
 * so the window means the same thing whatever the lanes' cadences are. */
export function pruneJobRuns(records, cutoffIso) {
  return records.filter((r) => typeof r.at === 'string' && r.at >= cutoffIso);
}

export function jobRunCutoff(nowMs, retentionDays = JOB_RUN_RETENTION_DAYS) {
  return new Date(nowMs - retentionDays * 86_400_000).toISOString();
}

/** The record as it stands, pruned to the retention window on disk too. A
 * missing or unreadable file must not stop a runner starting. */
export async function readJobRuns(file, nowMs = Date.now()) {
  let records = [];
  try {
    records = parseJobRuns(await fs.readFile(file, 'utf8'));
  } catch {
    return [];
  }
  const kept = pruneJobRuns(records, jobRunCutoff(nowMs));
  if (kept.length < records.length) {
    try {
      await fs.writeFile(file, kept.map(jobRunLine).join(''));
    } catch {
      // hygiene only
    }
  }
  return kept;
}

/** Append one firing. Every failure is swallowed: a record of the work must
 * never be able to stop the work. */
export async function appendJobRun(entry, file) {
  try {
    await fs.appendFile(file, jobRunLine(entry));
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one scheduled lane and leave evidence of the firing. The only `catch`
 * the lanes need: a throw is a `failed` outcome with its message kept.
 * `outcomeOf` maps a lane's return value to an outcome; `null` means it stood
 * down. `begin` opens the lane's workflow trace (scripts/workflow-history.mts)
 * or is null; `stepOf` maps a local lane's return value to its execute step's
 * result.
 */
export async function runRecordedLane(
  job,
  fn,
  outcomeOf = (result) => (result === null ? 'skipped' : 'ran'),
  { file, emit, now = Date.now, ship, begin = null, stepOf = stepResult },
) {
  const startedAtMs = now();
  const trace = begin ? begin(job, startedAtMs) : null;
  // Disk first, then the store, always.
  const keep = async (entry) => {
    // The workflow verdict is kept with the ledger independently of rich-step
    // retention.
    if (trace) entry.workflowState = trace.verdict(entry.outcome);
    if (trace) await trace.run('record', () => appendJobRun(entry, file));
    else await appendJobRun(entry, file);
    try {
      await ship(entry);
    } catch (err) {
      // A throw here would turn one failed firing into a second record of
      // itself.
      emit('ERROR', `job-run shipping threw: ${err?.message ?? err}`);
    }
  };
  try {
    const result = trace?.local ? await trace.run('execute', fn, stepOf) : await fn();
    trace?.adopt(result?.steps);
    const mapped = outcomeOf(result) ?? 'ran';
    const outcome = typeof mapped === 'string' ? { outcome: mapped, detail: null } : mapped;
    await keep(jobRunRecord({ job, ...outcome, startedAtMs, finishedAtMs: now() }));
    await trace?.finish(outcome.outcome);
    return result;
  } catch (err) {
    emit('ERROR', `job "${job}" failed: ${err?.message ?? err}`);
    await keep(
      jobRunRecord({
        job,
        outcome: 'failed',
        detail: err?.message ?? String(err),
        startedAtMs,
        finishedAtMs: now(),
      }),
    );
    await trace?.finish('failed');
    return null;
  }
}

// Shipping the record into `noticeos.job_runs`. The runner is the only
// writer, because it is the only witness, so re-sending is the normal case
// and the store is idempotent on (job, startedAt).

/** Pinned to `JOB_RUN_MAX_BATCH` in workers/ingest/src/job-runs.ts, which
 * rejects a longer body. */
export const JOB_RUN_SHIP_MAX = 500;
/** Unshipped firings held in memory: several days of everything. Past it the
 * oldest are dropped; the disk file still holds them, and the metric reads
 * each lane's latest firing. */
export const JOB_RUN_PENDING_MAX = 5_000;
/** How far back a restart re-sends. The store reads each lane's latest firing
 * and whether anything fired in the last day, so two days covers it. */
export const JOB_RUN_CATCHUP_DAYS = 2;

/** Is this record something the store will accept? One unacceptable record
 * in a batch would 422 every good record beside it. */
export function jobRunShippable(record) {
  return (
    typeof record?.job === 'string' &&
    typeof record?.at === 'string' &&
    JOB_RUN_OUTCOMES.includes(record?.outcome) &&
    Number.isInteger(record?.ms ?? 0)
  );
}

/**
 * What a restart re-sends: everything recent, plus every lane's last known
 * firing however old — a weekly collection that failed five days ago is
 * exactly the death this record exists to show. Duplicates are the price of
 * not tracking what got through; the store drops them on arrival.
 */
export function jobRunCatchup(records, nowMs, { days = JOB_RUN_CATCHUP_DAYS, max = JOB_RUN_PENDING_MAX } = {}) {
  const usable = records.filter(jobRunShippable);
  const cutoff = jobRunCutoff(nowMs, days);
  const chosen = new Map();
  // A NUL written as its escape (a literal one would hide this file from
  // grep): a byte neither half can hold, since a lane name holds spaces.
  const key = (r) => `${r.job}\u0000${r.at}`;
  for (const record of usable) if (record.at >= cutoff) chosen.set(key(record), record);
  const latest = new Map();
  for (const record of usable) {
    const held = latest.get(record.job);
    if (!held || record.at > held.at) latest.set(record.job, record);
  }
  for (const record of latest.values()) chosen.set(key(record), record);
  return [...chosen.values()]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .slice(-max);
}

/** One more firing on the queue, oldest dropped at the bound (see above). */
export function jobRunQueued(pending, record, max = JOB_RUN_PENDING_MAX) {
  const next = [...pending, record];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** The wire shape. `ms` travels rather than a finish timestamp because `ms`
 * is what was measured. */
export function jobRunPostBody(records) {
  return {
    runs: records.map((record) => ({
      job: record.job,
      startedAt: record.at,
      ms: record.ms ?? 0,
      outcome: record.outcome,
      ...(record.detail ? { detail: record.detail } : {}),
    })),
  };
}

/**
 * A skip is worth a line only when it is new: the same reason twice logs
 * once. `state.skipping` is the reason currently being suppressed, or null.
 */
export function skipIsNew(state, reason) {
  if (state.skipping === reason) return false;
  state.skipping = reason;
  return true;
}

/**
 * Arm shipping and seed the queue from the record read at startup, so firings
 * from before this process existed reach the store on the first tick after
 * the door opens. `runtime` is the child that serves the door:
 * `{ running, ready }`.
 */
export function armJobRunShipping(runtime, records, nowMs, state) {
  state.runtime = runtime;
  state.pending = jobRunCatchup(records, nowMs);
  return state.pending.length;
}

/**
 * Queue one firing and ship what is queued. Every exit is a return, never a
 * throw: a down door, a missing token or a 500 leaves the queue intact for
 * the next firing. A 422 is the one refusal that does not retry, or the queue
 * would jam behind a record that will never be accepted.
 */
export async function shipJobRunQueue(record, { state, post = fetch, readToken, emit, url, stopped = () => false }) {
  if (record) state.pending = jobRunQueued(state.pending, record);
  if (!state.runtime || stopped()) return null;

  const skip = (reason) => {
    if (skipIsNew(state, reason)) {
      emit('WARN', `job-run shipping paused — ${reason} (silent until it changes)`);
    }
    return null;
  };

  if (!state.runtime.running || !state.runtime.ready) return skip('the ingest is down/restarting');
  if (state.pending.length === 0) return null;

  const token = await readToken().catch(() => null);
  if (!token) return skip('no OPERATOR_TOKEN is configured for the ingest worker');

  const batch = state.pending.slice(0, JOB_RUN_SHIP_MAX);
  let res;
  try {
    res = await post(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(jobRunPostBody(batch)),
    });
  } catch (err) {
    return skip(`the ingest door did not answer (${err.message})`);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    if (res.status === 422) {
      state.pending = state.pending.slice(batch.length);
      emit('ERROR', `job-run shipping dropped ${batch.length} record(s) the store refused: ${detail}`);
      return 0;
    }
    return skip(`HTTP ${res.status} ${detail}`);
  }

  state.pending = state.pending.slice(batch.length);
  if (state.skipping !== null) {
    emit('INFO', `job-run shipping resumed (was paused: ${state.skipping})`);
    state.skipping = null;
  }
  return batch.length;
}

// ─── Recovery after downtime ─────────────────────────────────────────────────

/**
 * Recovery is explicit per lane. `maxAgeMs` is how long the latest missed
 * obligation remains useful; every lane runs at most once, however many ticks
 * the machine missed. Unknown cron expressions are excluded: the ingest
 * dispatch refuses them as `unknown_cron`.
 *
 * These are the ingest's own crons (workers/ingest/wrangler.jsonc). The
 * managed service adds its host lanes (scripts/runner/scheduler.mjs
 * STARTUP_CATCHUP_POLICIES).
 */
export const CRON_CATCHUP_POLICIES = Object.freeze([
  { job: 'cron 10,30,50 * * * *', expression: '10,30,50 * * * *', kind: 'cron', maxAgeMs: 36 * HOUR_MS },
  { job: 'cron 0 * * * *', expression: '0 * * * *', kind: 'cron', maxAgeMs: 2 * HOUR_MS },
  // The operator notification lane: two hours, like the freshness lane it
  // follows. Catching it up cannot duplicate anything; the lane records what
  // it has already said.
  { job: 'cron 5 * * * *', expression: '5 * * * *', kind: 'cron', maxAgeMs: 2 * HOUR_MS },
  { job: 'cron 30 2 * * *', expression: '30 2 * * *', kind: 'cron', maxAgeMs: 36 * HOUR_MS },
  { job: 'cron 0 3 * * *', expression: '0 3 * * *', kind: 'cron', maxAgeMs: 36 * HOUR_MS },
  { job: 'cron 30 3 * * *', expression: '30 3 * * *', kind: 'cron', maxAgeMs: 36 * HOUR_MS },
  { job: 'cron 0 4 * * *', expression: '0 4 * * *', kind: 'cron', maxAgeMs: 36 * HOUR_MS },
  { job: 'cron 30 4 * * *', expression: '30 4 * * *', kind: 'cron', maxAgeMs: 36 * HOUR_MS },
  { job: 'cron 15 12 * * *', expression: '15 12 * * *', kind: 'cron', maxAgeMs: 36 * HOUR_MS },
  // PostHog product analytics archive: an unchanged window re-archives as
  // `unchanged`, so catching it up is safe.
  { job: 'cron 30 12 * * *', expression: '30 12 * * *', kind: 'cron', maxAgeMs: 36 * HOUR_MS },
  { job: 'cron 45 12 * * 1', expression: '45 12 * * 1', kind: 'cron', maxAgeMs: 8 * DAY_MS },
  { job: 'cron */15 * * * *', expression: '*/15 * * * *', kind: 'cron', maxAgeMs: HOUR_MS },
]);

/** Latest recorded firing per lane, irrespective of outcome. A failed firing
 * is still a firing; catch-up is downtime recovery, not an infinite retry loop. */
function latestJobRunMap(records) {
  const latest = new Map();
  for (const record of records) {
    if (typeof record?.job !== 'string' || !Number.isFinite(Date.parse(record?.at ?? ''))) continue;
    const held = latest.get(record.job);
    if (!held || record.at > held.at) latest.set(record.job, record);
  }
  return latest;
}

/**
 * Plan the one bounded startup pass. The plan has no side effects and names
 * exclusions, making the recovery policy directly testable.
 */
export function startupCatchupPlan(configuredCrons, records, nowMs = Date.now(), policies = CRON_CATCHUP_POLICIES) {
  const configured = new Set(configuredCrons);
  const knownCronExpressions = new Set(
    [...CRON_CATCHUP_POLICIES, ...policies].filter((policy) => policy.kind === 'cron').map((policy) => policy.expression),
  );
  const excluded = [...configured]
    .filter((expression) => !knownCronExpressions.has(expression))
    .map((expression) => ({
      expression,
      reason: 'unknown cron excluded: no scheduled job runs on it',
    }));
  const latest = latestJobRunMap(records);
  const due = [];

  for (const policy of policies) {
    if (policy.kind === 'cron' && !configured.has(policy.expression)) continue;
    let scheduledAt;
    // The gap between the last two obligations is the lane's cadence, read
    // from the saved schedule.
    let intervalMs = null;
    try {
      const schedule = new Cron(policy.scheduleExpression ?? policy.expression, { timezone: policy.scheduleTimezone ?? 'UTC', paused: true });
      const runs = schedule.previousRuns(2, new Date(nowMs)); // newest first
      scheduledAt = runs[0] ?? null;
      if (runs.length > 1) intervalMs = runs[0].getTime() - runs[1].getTime();
      schedule.stop();
    } catch {
      excluded.push({ expression: policy.expression, reason: 'invalid recovery schedule' });
      continue;
    }
    if (!scheduledAt) continue;
    const scheduledAtMs = scheduledAt.getTime();
    const previous = latest.get(policy.job);
    if (previous && Date.parse(previous.at) >= scheduledAtMs) continue;
    const ageMs = nowMs - scheduledAtMs;
    if (ageMs < 0 || ageMs > policy.maxAgeMs) {
      excluded.push({
        expression: policy.expression,
        job: policy.job,
        reason: `latest obligation is older than the ${Math.round(policy.maxAgeMs / HOUR_MS)}h recovery window`,
      });
      continue;
    }
    due.push({ ...policy, scheduledAt: scheduledAt.toISOString(), ageMs, intervalMs });
  }
  // Cheapest cadence first: the fast lanes are the quickest to pay and the
  // ones whose staleness an operator sees. Ties keep policy order; no
  // measurable cadence goes to the back.
  const ordered = due
    .map((item, index) => ({ item, index, key: item.intervalMs ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map((entry) => entry.item);
  return { due: ordered, excluded };
}

/** The policies of the lanes that are enabled now, each at the schedule saved
 * for it. `current(id)` is the runner's armed schedule for a job. */
export function scheduledCatchupPolicies(policies, current) {
  return policies.flatMap((policy) => {
    const job = SCHEDULED_JOBS.find((candidate) => jobRunName(candidate) === policy.job);
    const schedule = job && current(job.id);
    if (!schedule?.enabled) return [];
    return [{ ...policy, scheduleExpression: schedule.cron, scheduleTimezone: scheduleTimezone(schedule) }];
  });
}

/** Is a queued catch-up still what the runner has armed? A save during
 * catch-up must also retire the obligation already queued. */
export function catchupStillArmed(item, current) {
  return Boolean(current?.enabled && current.cron === item.scheduleExpression && scheduleTimezone(current) === item.scheduleTimezone);
}

/**
 * Which lanes the one startup catch-up pass currently owns. Ownership is per
 * lane, never global: the pass claims the lanes in its plan and releases each
 * the moment its catch-up firing finishes; everything else keeps ticking.
 */
export function createCatchupOwnership() {
  const owned = new Set();
  return {
    /** Claim every lane in the plan before the first firing. */
    own(jobs) {
      for (const job of jobs) owned.add(job);
    },
    /** Give one lane back to its regular schedule. */
    release(job) {
      owned.delete(job);
    },
    /** Does catch-up still owe this lane a firing? */
    holds(job) {
      return owned.has(job);
    },
    clear() {
      owned.clear();
    },
    get size() {
      return owned.size;
    },
  };
}

/** `held` is this one lane's ownership, not a global "catch-up is running". */
export function scheduledDuringCatchupDecision(held, job) {
  return held
    ? {
        run: false,
        outcome: 'skipped',
        detail: 'startup catch-up in progress',
        text: `regular ${job} tick held while startup catch-up still owns that lane's recovery`,
      }
    : { run: true, outcome: null, detail: null, text: null };
}

/** A catch-up firing's outcome, marked with the obligation it paid. */
export function catchupOutcome(mapper, scheduledAt) {
  return (result) => {
    const mapped = mapper(result) ?? 'ran';
    const normalized = typeof mapped === 'string' ? { outcome: mapped, detail: null } : mapped;
    return {
      outcome: normalized.outcome,
      detail: [`startup catch-up for ${scheduledAt}`, normalized.detail].filter(Boolean).join(' · '),
    };
  };
}
