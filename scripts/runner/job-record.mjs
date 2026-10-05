// runner/job-record.mjs — the managed runner's job-run record: one line per
// lane per firing in `.local/logs/job-runs.jsonl`, read back at startup, and
// shipped to the store's `job_runs` through this runner's door. The record's
// shape and rules are scripts/job-runs.mjs, shared with `pnpm start`'s
// schedule; this module binds them to this runner's file, log and door.

import path from 'node:path';
import {
  armJobRunShipping as armShipping,
  readJobRuns,
  runRecordedLane,
  shipJobRunQueue,
} from '../job-runs.mjs';
import { beginWorkflowRun } from '../workflow-history.mjs';
import { stepResult } from '../workflow-trace.mjs';
import { CONFIG, LOGS_DIR } from './config.mjs';
import { isShuttingDown } from './lifecycle.mjs';
import { log } from './log.mjs';
import { operatorToken } from './operator-token.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// THE JOB-RUN RECORD — evidence that a scheduled lane fired, kept per firing
// in `.local/logs/job-runs.jsonl` and mirrored into `noticeos.job_runs`. What
// it is and why the file comes first: scripts/job-runs.mjs, shared with the
// schedule of an installation `pnpm start` runs.
// ─────────────────────────────────────────────────────────────────────────────

export const JOB_RUNS_FILE = path.join(LOGS_DIR, 'job-runs.jsonl');

/**
 * What the record says about each lane: when it last fired, what that firing
 * amounted to, and the tally behind it. Sorted by lane so two startups a week
 * apart print comparable lines.
 */
export function summarizeJobRuns(records) {
  const byJob = new Map();
  for (const record of records) {
    const entry = byJob.get(record.job) ?? {
      job: record.job,
      last: null,
      lastOutcome: null,
      ran: 0,
      skipped: 0,
      failed: 0,
    };
    if (entry[record.outcome] !== undefined) entry[record.outcome] += 1;
    if (entry.last === null || record.at > entry.last) {
      entry.last = record.at;
      entry.lastOutcome = record.outcome;
    }
    byJob.set(record.job, entry);
  }
  return [...byJob.values()].sort((a, b) => a.job.localeCompare(b.job));
}

/** What a regular tick returns when the startup catch-up holds its lane: the
 * firing is recorded with the hold's own outcome and no step result. */
export const REGULAR_LANE_HELD = Symbol('regular-lane-held-for-startup-catchup');

/** "3h ago", for a line an operator reads at a glance rather than parses. */
export function jobRunAge(iso, nowMs) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'never';
  const minutes = Math.max(0, Math.round((nowMs - then) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * What the runner says about the record at startup — the payoff for keeping it.
 *
 * At most two lines: one naming every lane's last firing, and a WARN when a
 * lane's last firing FAILED, because that is the state a restart is most often
 * an operator's response to. An empty record is its own line rather than
 * silence: "no history yet" and "the history says nothing happened" are
 * different facts, and the second one is the alarming one.
 */
export function jobRunStartupLines(summary, nowMs, file = JOB_RUNS_FILE) {
  if (summary.length === 0) {
    return [{ level: 'INFO', text: `job-run record: empty — nothing recorded yet (${file})` }];
  }
  const lanes = summary
    .map((s) => `${s.job} ${s.lastOutcome} ${jobRunAge(s.last, nowMs)}`)
    .join(' · ');
  const lines = [
    { level: 'INFO', text: `job-run record — ${summary.length} lane(s): ${lanes} (${file})` },
  ];
  const failing = summary.filter((s) => s.lastOutcome === 'failed');
  if (failing.length > 0) {
    lines.push({
      level: 'WARN',
      text:
        `job-run record: ${failing.map((s) => `${s.job} (last ${jobRunAge(s.last, nowMs)})`).join(', ')} ` +
        `last FAILED — whatever broke that lane was still broken when this runner stopped.`,
    });
  }
  return lines;
}

/**
 * Run one scheduled lane and leave evidence of the firing
 * (scripts/job-runs.mjs runRecordedLane): in this runner's record, shipped to
 * its store, and traced for Workflows when it is this runner's record.
 */
export async function runJobLane(
  job,
  fn,
  outcomeOf = (result) => (result === null ? 'skipped' : 'ran'),
  deps = {},
) {
  const { file = JOB_RUNS_FILE, emit = log, now = Date.now, ship = shipJobRuns } = deps;
  return runRecordedLane(job, fn, outcomeOf, {
    file,
    emit,
    now,
    ship,
    begin: file === JOB_RUNS_FILE ? beginWorkflowRun : null,
    stepOf: (value) => (value === REGULAR_LANE_HELD ? stepResult(null) : stepResult(value)),
  });
}

/** Read the record back, prune it to the retention window, and say what it says.
 * Called once at startup — the moment an operator is most likely to be asking
 * "has this thing been running?". */
export async function reportJobRuns(nowMs = Date.now(), deps = {}) {
  const { file = JOB_RUNS_FILE, emit = log } = deps;
  const kept = await readJobRuns(file, nowMs);
  for (const line of jobRunStartupLines(summarizeJobRuns(kept), nowMs, file)) {
    emit(line.level, line.text);
  }
  return kept;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHIPPING THE RECORD — the disk half above, mirrored into `noticeos.job_runs`
// through this runner's door (scripts/job-runs.mjs shipJobRunQueue).
// ─────────────────────────────────────────────────────────────────────────────

export function jobRunsUrl(config) {
  return `http://${config.ingestHost}:${config.ingestPort}/api/job-runs`;
}

/** Armed by `supervise()` once there is a runtime to ask about. Until then —
 * `pnpm os:up --backup` by hand, or a test driving one lane — shipping is inert
 * and the firing is disk-only, which is the same outcome as a door that is
 * simply down. */
const jobRunShipState = { runtime: null, pending: [], skipping: null };

/** Arm shipping and seed the queue from the disk record
 * (scripts/job-runs.mjs armJobRunShipping). */
export function armJobRunShipping(runtime, records = [], nowMs = Date.now(), state = jobRunShipState) {
  return armShipping(runtime, records, nowMs, state);
}

/** Queue one firing and ship what is queued to this runner's store
 * (scripts/job-runs.mjs shipJobRunQueue). */
export async function shipJobRuns(record = null, deps = {}) {
  const {
    state = jobRunShipState,
    post = fetch,
    readToken = operatorToken,
    emit = log,
    url = jobRunsUrl(CONFIG),
    stopped = () => isShuttingDown(),
  } = deps;
  return shipJobRunQueue(record, { state, post, readToken, emit, url, stopped });
}
