// job-runs.mjs — the record every scheduled lane leaves, and the recovery it
// allows after downtime. Shared by the managed service's runner
// (scripts/os-up.mjs) and the schedule of an installation `pnpm start` runs
// (scripts/start-schedule.mjs, bead ro-ujb9.156), so both keep the same record,
// ship it the same way and catch up by the same policy.
//
// Every effect here — the file, the clock, the log, the store — is passed in.
// The caller owns where its installation's state is.
//
// THE RECORD. Every lane already logs what it did, and a log is the wrong shape
// for the question that matters: "did the nightly backup run last night?" is
// answered by scrolling a file for an ABSENCE, and absence is the one thing a
// log cannot prove. That is the same defect as asset #0's `cronRunSuccess = 1`,
// a constant with no run ledger behind it: a cron that never fired still
// reports success, so the metric cannot fail (docs/19 finding 6, ro-ic5).
//
// So each firing appends one line to `.local/logs/job-runs.jsonl`: WHICH lane,
// WHEN it started, how long it took, and what it amounted to — ran / skipped /
// failed. A lane that died is then legible as a LAST RUN that stopped moving,
// at startup, on one line, rather than inferred from silence.
//
// The grain is the LANE, deliberately. A per-item failure inside a lane (one
// spoke's `bd` refusing, one non-201 POST) stays an ERROR line: those are
// expected, individually recoverable, and the lane firing at all is the fact
// this record exists to keep. `failed` here means the firing itself came apart.
//
// THE FILE IS THE RECORD; THE TABLE IS ITS MIRROR (ro-uwo.4, 2026-08-04). The
// OS's own store is served by the very runtime these lanes fire at, so a record
// that needs the ingest up cannot testify about an ingest that was down — which
// is why the line hits disk FIRST and always. But a Worker cannot read this
// machine's filesystem, and asset #0's `cronRunSuccess` has to come from
// somewhere, so each firing is also shipped through `POST /api/job-runs` into
// `job_runs` (db/0022, operator-approved). Door down = disk only, and the record
// catches up on the next firing that finds the door open. Nothing is ever lost
// by a failed ship, because the ship is not where the record lives.

import fs from 'node:fs/promises';
import { Cron } from 'croner';
import { SCHEDULED_JOBS, jobRunName, scheduleTimezone } from './scheduled-jobs.mjs';
import { stepResult } from './workflow-trace.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ─── The record ──────────────────────────────────────────────────────────────

/** How much history is kept. Long enough that a monthly-cadence question ("has
 * the backup run every night since the last restart?") has data, short enough
 * that the file stays a few megabytes at the busiest lane's one-a-minute. */
export const JOB_RUN_RETENTION_DAYS = 30;

/** What a firing can amount to. `skipped` is a first-class outcome, not a
 * non-event: a lane that stood down every tick for a week is a finding. */
export const JOB_RUN_OUTCOMES = ['ran', 'skipped', 'failed'];

/**
 * One firing, as the record keeps it.
 *
 * `at` is when the firing STARTED, and `ms` how long it took — so the finish is
 * derivable and the file stays one small object per line. There is no separate
 * "scheduled at": the lane runs on its tick, so `at` is that tick to within the
 * time it takes croner to call a function, and a second timestamp that is
 * always equal to the first is a field that will eventually disagree with
 * itself.
 */
export function jobRunRecord({ job, outcome, detail = null, startedAtMs, finishedAtMs }) {
  const at = new Date(startedAtMs).toISOString();
  const record = {
    at,
    job,
    outcome: JOB_RUN_OUTCOMES.includes(outcome) ? outcome : 'failed',
    ms: Math.max(0, Math.round((finishedAtMs ?? startedAtMs) - startedAtMs)),
  };
  // Truncated, because the detail is often an error message and one runaway
  // stack must not cost the record its readability.
  if (detail) record.detail = String(detail).replace(/\s+/g, ' ').trim().slice(0, 200);
  return record;
}

export function jobRunLine(record) {
  return `${JSON.stringify(record)}\n`;
}

/** Records back from the file. A malformed line is skipped rather than fatal:
 * this file is appended by a process that can be SIGKILLed mid-write, so a torn
 * last line is a normal thing to find, not a corruption to refuse. */
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

/** Everything at or after the cutoff. Pruning is by DATE rather than by line
 * count so the window means the same thing whatever the lanes' cadences are. */
export function pruneJobRuns(records, cutoffIso) {
  return records.filter((r) => typeof r.at === 'string' && r.at >= cutoffIso);
}

export function jobRunCutoff(nowMs, retentionDays = JOB_RUN_RETENTION_DAYS) {
  return new Date(nowMs - retentionDays * 86_400_000).toISOString();
}

/** The record as it stands, pruned to the retention window — on disk too.
 * Called once at startup. A missing file is the normal first-run case and an
 * unreadable one must not stop a runner starting; pruning is hygiene, never a
 * precondition. */
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

/** Append one firing. Every failure here is swallowed: a record of the work must
 * never be able to stop the work, which is the same posture as the log stream. */
export async function appendJobRun(entry, file) {
  try {
    await fs.appendFile(file, jobRunLine(entry));
    return true;
  } catch {
    // A record we cannot write is not worth a runner we cannot run.
    return false;
  }
}

/**
 * Run one scheduled lane and leave evidence of the firing.
 *
 * This is also the only `catch` the lanes need: a throw is an outcome (`failed`)
 * with its message kept, rather than an unhandled rejection that takes the
 * process down or a silent one that takes the tick.
 *
 * `outcomeOf` maps a lane's own return value to an outcome. The convention every
 * lane follows: `null` means it stood down (a down ingest, an unreachable hub,
 * nothing to do), anything else means it did its pass.
 *
 * `begin` opens the lane's workflow trace (scripts/workflow-history.mts) or is
 * null for no trace; `stepOf` maps a local lane's return value to its execute
 * step's result.
 */
export async function runRecordedLane(
  job,
  fn,
  outcomeOf = (result) => (result === null ? 'skipped' : 'ran'),
  { file, emit, now = Date.now, ship, begin = null, stepOf = stepResult },
) {
  const startedAtMs = now();
  const trace = begin ? begin(job, startedAtMs) : null;
  // Disk first, then the store — in that order, always. The append is what makes
  // the firing a fact; the ship is what makes it readable by a Worker.
  const keep = async (entry) => {
    // Persist the workflow verdict with the retained ledger independently of
    // rich-step retention; the existing coarse outcome contract is unchanged.
    if (trace) entry.workflowState = trace.verdict(entry.outcome);
    if (trace) await trace.run('record', () => appendJobRun(entry, file));
    else await appendJobRun(entry, file);
    try {
      await ship(entry);
    } catch (err) {
      // Same posture as the append above: a mirror we cannot write is not worth
      // a lane we cannot run — and in the catch below, a throw here would turn
      // one failed firing into a second record of itself.
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

// ─── Shipping the record ─────────────────────────────────────────────────────
//
// The disk record, mirrored into `noticeos.job_runs` so asset #0 can derive
// `cronRunSuccess` from firings instead of asserting it. The runner is the ONLY
// writer, because it is the only witness: a lane that fires while the ingest is
// restarting is invisible to the ingest. That makes re-sending the normal case
// rather than the error case, and the store is idempotent on (job, startedAt)
// to match — so everything here is free to be simple about what it has already
// shipped, which is nothing more precise than "whatever is still queued".

/** The outer bound on one POST — pinned to `JOB_RUN_MAX_BATCH` in
 * workers/ingest/src/job-runs.ts, which rejects a longer body. */
export const JOB_RUN_SHIP_MAX = 500;
/** How many unshipped firings are held in memory. A day of the busiest lane is
 * 1,440; this is several days of everything. Past it the OLDEST are dropped:
 * the disk file still holds them, and the metric on the other end reads each
 * lane's LATEST firing, which is the end of the queue that survives. */
export const JOB_RUN_PENDING_MAX = 5_000;
/** How far back a restart re-sends. The store's read only looks at each lane's
 * latest firing and whether anything fired in the last day, so two days covers
 * everything it can use; older rows the store may be missing would change no
 * answer it gives. */
export const JOB_RUN_CATCHUP_DAYS = 2;

/** Is this record something the store will accept? A file appended by a
 * killable process can hold a torn or hand-edited line, and one unacceptable
 * record in a batch would 422 every good record beside it. */
export function jobRunShippable(record) {
  return (
    typeof record?.job === 'string' &&
    typeof record?.at === 'string' &&
    JOB_RUN_OUTCOMES.includes(record?.outcome) &&
    Number.isInteger(record?.ms ?? 0)
  );
}

/**
 * What a restart re-sends: everything recent, PLUS every lane's last known
 * firing however old.
 *
 * The second half is not tidiness. A weekly collection that failed five days ago
 * is exactly the kind of death this record exists to show, and a flat time
 * window would drop it — leaving the store's view of that lane blank and its
 * verdict a `1` earned by the lanes that happen to fire often.
 *
 * Duplicates are the price of not tracking what got through, and the store
 * drops them on arrival.
 */
export function jobRunCatchup(records, nowMs, { days = JOB_RUN_CATCHUP_DAYS, max = JOB_RUN_PENDING_MAX } = {}) {
  const usable = records.filter(jobRunShippable);
  const cutoff = jobRunCutoff(nowMs, days);
  const chosen = new Map();
  // The separator is a NUL written as its escape — a literal one would make this
  // whole file invisible to plain grep (ro-20n). It has to be a byte neither
  // half can hold, and a lane name holds spaces: `cron 45 12 * * 1`.
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

/** The disk record's field names are its own; this is the wire. `ms` travels
 * rather than a finish timestamp because `ms` is what was measured — the store
 * derives the finish once, so it can never hold two that disagree. */
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
 * A skip is worth a line only when it is NEW. Pure so the no-spam rule is a
 * test rather than a hope: the same reason twice logs once, and a different
 * reason always logs. `state.skipping` is the reason currently being
 * suppressed; null = nothing is being skipped.
 */
export function skipIsNew(state, reason) {
  if (state.skipping === reason) return false;
  state.skipping = reason;
  return true;
}

/**
 * Arm shipping and seed the queue from what the disk record already holds.
 *
 * Called with the record read at startup, so the firings that happened while
 * the store was unreachable — including the ones from before this process
 * existed — reach it on the first tick after the door opens. `runtime` is the
 * child that serves the door: `{ running, ready }`.
 */
export function armJobRunShipping(runtime, records, nowMs, state) {
  state.runtime = runtime;
  state.pending = jobRunCatchup(records, nowMs);
  return state.pending.length;
}

/**
 * Queue one firing and ship what is queued.
 *
 * Every exit here is a return, never a throw: this runs inside a recorded lane,
 * and a record of the work must never be able to stop the work. A door that is
 * down, a missing token, a 500 — all of them leave the queue intact for the next
 * firing to carry.
 *
 * A 422 is the one refusal that does NOT retry. The store validated the body and
 * said no; re-sending the same bytes every minute would jam the queue behind a
 * record that is never going to be accepted, and the disk file is still the
 * record either way.
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
 * the machine missed. Unknown cron expressions are excluded: no scheduled job
 * runs on one, and the ingest dispatch refuses it as `unknown_cron`.
 *
 * These are the ingest's own crons (workers/ingest/wrangler.jsonc). The managed
 * service adds its host lanes to them (scripts/runner/scheduler.mjs
 * STARTUP_CATCHUP_POLICIES).
 */
export const CRON_CATCHUP_POLICIES = Object.freeze([
  { job: 'cron 10,30,50 * * * *', expression: '10,30,50 * * * *', kind: 'cron', maxAgeMs: 36 * HOUR_MS },
  { job: 'cron 0 * * * *', expression: '0 * * * *', kind: 'cron', maxAgeMs: 2 * HOUR_MS },
  // The operator notification lane (bead `ro-vu8d.23`). Two hours, like the
  // freshness lane it follows: after a short outage the operator should still
  // hear about what broke while the machine was down, and after a long one the
  // conditions have either cleared or are on the desk waiting. Catching it up
  // cannot duplicate anything — the lane records what it has already said.
  { job: 'cron 5 * * * *', expression: '5 * * * *', kind: 'cron', maxAgeMs: 2 * HOUR_MS },
  { job: 'cron 30 2 * * *', expression: '30 2 * * *', kind: 'cron', maxAgeMs: 36 * HOUR_MS },
  { job: 'cron 0 3 * * *', expression: '0 3 * * *', kind: 'cron', maxAgeMs: 36 * HOUR_MS },
  { job: 'cron 30 3 * * *', expression: '30 3 * * *', kind: 'cron', maxAgeMs: 36 * HOUR_MS },
  { job: 'cron 0 4 * * *', expression: '0 4 * * *', kind: 'cron', maxAgeMs: 36 * HOUR_MS },
  { job: 'cron 30 4 * * *', expression: '30 4 * * *', kind: 'cron', maxAgeMs: 36 * HOUR_MS },
  { job: 'cron 15 12 * * *', expression: '15 12 * * *', kind: 'cron', maxAgeMs: 36 * HOUR_MS },
  // PostHog product analytics archive (bead `ro-ghis.1`): same 36 h as the
  // other daily archives. A late run reads the same trailing windows, and an
  // unchanged window re-archives as `unchanged`, so catching it up is safe.
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
    // The gap between the last two obligations IS the lane's cadence, read from
    // the schedule the operator actually saved rather than from a hard-coded
    // table that would drift the moment a cron is edited in the desk.
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
  // Cheapest cadence first. The wall's 15-minute counters must not queue behind
  // a 40-minute weekly collection: the fast lanes are both the quickest to pay
  // and the ones whose staleness an operator sees. Ties keep policy order, and
  // a schedule with no measurable cadence keeps policy order at the back.
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
 * Which lanes the one startup catch-up pass currently owns.
 *
 * Ownership is per lane, never global. The pass claims exactly the lanes in its
 * plan and releases each one the moment that lane's catch-up firing finishes,
 * so a 40-minute weekly recovery can no longer hold the 20-minute Mediavine
 * lane, the beads snapshot, or any other lane that was never in the plan.
 * Everything outside the set keeps ticking on its own schedule, concurrently.
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

/** `held` is this ONE lane's ownership, not a global "catch-up is running". */
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
