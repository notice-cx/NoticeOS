import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lateWritingCommand } from './test-late-command.mjs';
import { mayReadOwnerConfig } from './test-config-isolation.mjs';

import {
  BEADS_CLOSED_LIMIT,
  BEADS_CREATED_LIMIT,
  BEADS_CLOSED_WINDOW_DAYS,
  BEADS_READY_LIMIT,
  BEADS_WAITING_LIMIT,
  CONFIG,
  HANDOFF_ASSET_FIELD,
  HANDOFF_KEY_FIELD,
  HANDOFF_KIND_FIELD,
  HANDOFF_LABEL,
  HANDOFF_LIMIT,
  handoffEntries,
  handoffListArgs,
  COLLECTION_REVIEW_ACCEPTANCE,
  PANEL_REVIEW_ACCEPTANCE,
  PANEL_REVIEW_ACTOR,
  PANEL_REVIEW_ASSET_KEY,
  PANEL_REVIEW_DATE_KEY,
  PANEL_REVIEW_DUE_DAYS,
  PANEL_REVIEW_LABEL,
  panelReviewAcceptance,
  panelReviewAlreadyFiled,
  panelReviewCreateArgs,
  panelReviewCreatedId,
  panelReviewDescription,
  osCheckoutName,
  runnerPaths,
  panelReviewDueDate,
  panelReviewEntry,
  invalidPanelReview,
  panelReviewListArgs,
  panelReviewPanelDate,
  panelReviewTitle,
  INVALID_PANEL_REVIEW_LABEL,
  parsePanelLandings,
  runPanelReviewFiler,
  runWatchReadbackFiler,
  serpPanelLandingsUrl,
  PUSH_STATE_ACCEPTANCE,
  PUSH_STATE_ACTOR,
  PUSH_STATE_ASSET_KEY,
  PUSH_STATE_COMMIT_LIMIT,
  PUSH_STATE_HUMAN_LABEL,
  PUSH_STATE_LABEL,
  beadsCreatedId,
  beadsGateCheckArgs,
  oldestUnpushedAt,
  parseRevListCounts,
  parseUnpushedCommits,
  pushStateCloseArgs,
  pushStateCloseReason,
  pushStateCountArgs,
  pushStateCreateArgs,
  pushStateDecision,
  pushStateDescription,
  pushStateFetchArgs,
  pushStateListArgs,
  pushStateLogArgs,
  pushStateOpenBeads,
  pushStateSpokeDecision,
  pushStateUnreadReason,
  pushStateTitle,
  runPushStateFiler,
  beadsClosedSince,
  beadsHubDiagnosis,
  beadsHubHealthLine,
  parseDoltServers,
  beadsPollArgs,
  beadsSnapshotUrl,
  collectBeadsSnapshot,
  cronFireDecision,
  doorOwnershipDecision,
  ingestDoorEnv,
  isDescendantOf,
  JOB_RUN_CATCHUP_DAYS,
  JOB_RUN_OUTCOMES,
  JOB_RUN_PENDING_MAX,
  JOB_RUN_RETENTION_DAYS,
  JOB_RUN_SHIP_MAX,
  armJobRunShipping,
  jobRunCatchup,
  jobRunCutoff,
  jobRunLine,
  jobRunPostBody,
  jobRunQueued,
  jobRunRecord,
  jobRunShippable,
  jobRunStartupLines,
  jobRunsUrl,
  integrationProvidersUrl,
  configDocumentsUrl,
  configStoreLine,
  legacyEnvLine,
  reportConfigStore,
  reportLegacyEnvCredentials,
  shipJobRuns,
  listenerOwnersArgs,
  parseJobRuns,
  parseListenerOwners,
  parseProcessParents,
  pruneJobRuns,
  reportJobRuns,
  runJobLane,
  summarizeJobRuns,
  STARTUP_CATCHUP_POLICIES,
  createCatchupOwnership,
  scheduledDuringCatchupDecision,
  startupCatchupPlan,
  beadsDatabaseName,
  parseBeadsDatabases,
  parseBeadsProjects,
  TASK_MAP_ACTOR,
  TASK_MAP_ASSET_KEY,
  TASK_MAP_HUMAN_LABEL,
  TASK_MAP_LABEL,
  beadsDatabaseDrift,
  runTaskMapCheck,
  taskMapBeadAsset,
  taskMapOpenBeads,
  taskMapTitle,
  resolveBin,
  resolveTowerExposure,
  TOWER_NETWORK_NOTICE,
  towerChild,
  rotateLogFile,
  runBd,
  runBeadsPoll,
  runPanelRefresh,
  runnerArmDecision,
  managedOrphanDecision,
  summarizeBeadsProject,
  beadsGateReason,
  EXIT_RUNTIME_COPY,
  runtimeCopyRefusal,
  tickRefusal,
} from './os-up.mjs';
import { doorErrorCode, fireScheduledTrigger } from './ingest-door.mjs';
import { gateReason } from '../packages/contract/src/task-gate.mjs';
import { captureWorkflowOutput, isWorkflowStepOutput } from './workflow-output.mjs';
import { stepResult } from './workflow-trace.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('supervision can never apply an operator-only migration', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'scripts', 'os-up.mjs'), 'utf8');
  assert.doesNotMatch(source, /d1[\s'",]+migrations[\s'",]+apply/u);
  assert.doesNotMatch(source, /postgres-migrate\.mjs|['"]postgres:migrate['"]/u);
  assert.match(source, /Postgres migrations are operator-only — startup applies none/u);
});

test('the persistent runner log rotates at a hard byte bound and caps history', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-up-log-'));
  const file = path.join(dir, 'os-up.log');
  try {
    writeFileSync(file, 'current-log');
    writeFileSync(`${file}.1`, 'previous-log');
    writeFileSync(`${file}.2`, 'expired-log');
    assert.equal(await rotateLogFile(file, { maxBytes: 5, keep: 2 }), true);
    assert.equal(readFileSync(`${file}.1`, 'utf8'), 'current-log');
    assert.equal(readFileSync(`${file}.2`, 'utf8'), 'previous-log');
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('os:up binds the Tower to loopback by default, including an empty setting', () => {
  for (const value of [undefined, '', '  ']) assert.equal(resolveTowerExposure([], value), false);
  assert.deepEqual(towerChild({ exposeTowerToLan: false, database: {} }).args.slice(-2), ['--host', '127.0.0.1']);
});

test('--local opts out of LAN exposure', () => {
  assert.equal(resolveTowerExposure(['--local'], undefined), false);
});

test('the launchd-compatible false environment value opts out', () => {
  assert.equal(resolveTowerExposure([], 'false'), false);
  assert.equal(resolveTowerExposure([], '0'), false);
});

test('network exposure requires an explicit valid opt-in and reports the standalone trust boundary', () => {
  for (const value of ['true', '1', ' TRUE ']) assert.equal(resolveTowerExposure([], value), true);
  for (const value of ['yes', 'typo', '2']) assert.throws(() => resolveTowerExposure([], value), /OS_UP_HOST must be/);
  assert.equal(resolveTowerExposure(['--local'], 'typo'), false);
  assert.equal(resolveTowerExposure(['--host'], 'typo'), true);
  assert.deepEqual(towerChild({ exposeTowerToLan: true, database: {} }).args.slice(-2), ['--host', '0.0.0.0']);
  assert.match(TOWER_NETWORK_NOTICE, /Standalone has no login.*read and change.*authenticated access tunnel/u);
  assert.match(readFileSync(new URL('./os-up.mjs', import.meta.url), 'utf8'), /if \(exposeTowerToLan\) log\('WARN', TOWER_NETWORK_NOTICE\)/u);
});

test('an explicit --host preserves compatibility and overrides the environment', () => {
  assert.equal(resolveTowerExposure(['--host'], 'false'), true);
});

test('conflicting network flags fail closed', () => {
  assert.throws(
    () => resolveTowerExposure(['--host', '--local'], undefined),
    /either --host or --local/,
  );
});

// Single instance: a second runner would arm a second copy of every ingest
// cron at the same pinned port and run each schedule twice on a metered lane.

test('a free ingest port is this runner taking ownership of the crons', () => {
  const d = runnerArmDecision({ ingestPortAnswers: false }, CONFIG);
  assert.equal(d.arm, true);
  assert.equal(d.level, 'INFO');
  assert.match(d.text, /127\.0\.0\.1:8791/);
});

test('a second runner refuses to arm rather than double-firing every cron', () => {
  const d = runnerArmDecision({ ingestPortAnswers: true }, CONFIG);
  assert.equal(d.arm, false);
  // ERROR, not WARN: this is a refusal to run, not a note about a degraded one.
  assert.equal(d.level, 'ERROR');
  assert.match(d.text, /REFUSING to start/);
});

test('the refusal says what it would have cost and how to clear it', () => {
  const d = runnerArmDecision({ ingestPortAnswers: true }, CONFIG);
  assert.match(d.text, /TWICE/);
  assert.match(d.text, /bills a metered lane twice/);
  assert.match(d.text, /no children, no crons, no migrations/);
  assert.match(d.text, /pnpm os:status/);
  assert.match(d.text, /pnpm os:doctor/);
  assert.match(d.text, /pnpm os:restart/);
  assert.match(d.text, /foreground pnpm os:up terminal/);
});

test('the guard asks about the pinned ingest port, not a hardcoded one', () => {
  // Moving CONFIG.ingestPort must move the probe and the refusal's diagnosis —
  // the port map is one source of truth even though recovery is now repo-owned.
  const d = runnerArmDecision({ ingestPortAnswers: true }, { ingestHost: '127.0.0.1', ingestPort: 9999 });
  assert.match(d.text, /127\.0\.0\.1:9999/);
  assert.match(d.text, /pnpm os:status/);
});

test('a crashed runner leaves nothing behind that could refuse the next one', () => {
  // The guard is a listening socket, not a pidfile: nothing is written, so no
  // stale claim outlives a SIGKILL.
  assert.equal(runnerArmDecision({ ingestPortAnswers: false }, CONFIG).arm, true);
});

test('the occupied-door refusal prevents duplicate schedulers before anything starts', () => {
  const d = runnerArmDecision({ ingestPortAnswers: true }, CONFIG);
  assert.match(d.text, /TWO schedulers/);
  assert.match(d.text, /no children, no crons, no migrations/);
});

test('a forced managed-runner exit may recover only its fresh, positively identified child group', () => {
  const previous = {
    managed: true,
    pid: 800,
    towerPid: 900,
    updatedAt: '2026-08-04T11:59:30.000Z',
  };
  assert.deepEqual(
    managedOrphanDecision({
      previous,
      previousRunnerAlive: false,
      owners: [{ pid: 941, pgid: 900 }],
      nowMs: Date.parse('2026-08-04T12:00:00.000Z'),
    }),
    {
      recover: true,
      group: 900,
      reason: 'managed predecessor 800 is gone; its child group 900 owns the door',
    },
  );
});

test('orphan recovery never kills a manual, live, stale, foreign, or unprovable process', () => {
  const fresh = {
    managed: true,
    pid: 800,
    towerPid: 900,
    updatedAt: '2026-08-04T11:59:30.000Z',
  };
  const input = {
    previous: fresh,
    previousRunnerAlive: false,
    owners: [{ pid: 941, pgid: 900 }],
    nowMs: Date.parse('2026-08-04T12:00:00.000Z'),
  };
  assert.equal(managedOrphanDecision({ ...input, previous: { ...fresh, managed: false } }).recover, false);
  assert.equal(managedOrphanDecision({ ...input, previousRunnerAlive: true }).recover, false);
  assert.equal(
    managedOrphanDecision({ ...input, previous: { ...fresh, updatedAt: '2026-08-04T11:00:00.000Z' } }).recover,
    false,
  );
  assert.equal(managedOrphanDecision({ ...input, owners: [{ pid: 941, pgid: 777 }] }).recover, false);
  assert.equal(managedOrphanDecision({ ...input, owners: null }).recover, false);
});

// The ingest door: one runtime serves both Workers, so the ingest's address is
// a loopback listener the tower's vite dev server binds, and the port map above
// is the only place that number lives.

test('the tower runtime is told the door address from CONFIG, not a literal', () => {
  assert.deepEqual(ingestDoorEnv({ ingestHost: '127.0.0.1', ingestPort: 9999 }), {
    OS_UP_INGEST_DOOR_HOST: '127.0.0.1',
    OS_UP_INGEST_DOOR_PORT: '9999',
  });
});

test('the door the runner opens is the port the scheduler fires at', () => {
  const env = ingestDoorEnv(CONFIG);
  assert.equal(env.OS_UP_INGEST_DOOR_PORT, String(CONFIG.ingestPort));
  assert.equal(env.OS_UP_INGEST_DOOR_HOST, CONFIG.ingestHost);
  // Loopback, always: the ingest's scheduled trigger has no authentication of
  // its own, and the tower it now lives inside binds the LAN.
  assert.match(env.OS_UP_INGEST_DOOR_HOST, /^127\./);
});

// Startup catch-up pays the latest missed obligation; it never replays an
// outage tick-for-tick or guesses what an unknown expression means.

test('every configured ingest cron has an explicit catch-up policy', () => {
  const wrangler = readFileSync(path.join(REPO_ROOT, 'workers/ingest/wrangler.jsonc'), 'utf8');
  const configured = JSON.parse(wrangler.match(/"crons"\s*:\s*(\[[^\]]+\])/u)[1]);
  const policies = STARTUP_CATCHUP_POLICIES
    .filter((policy) => policy.kind === 'cron')
    .map((policy) => policy.expression);
  assert.deepEqual(new Set(policies), new Set(configured));
});

test('twenty missed fast ticks become one latest obligation, never twenty replays', () => {
  const policies = [
    { job: 'cron */15 * * * *', expression: '*/15 * * * *', kind: 'cron', maxAgeMs: 60 * 60 * 1000 },
  ];
  const plan = startupCatchupPlan(
    ['*/15 * * * *'],
    [{ at: '2026-08-04T07:00:00.000Z', job: 'cron */15 * * * *', outcome: 'ran', ms: 1 }],
    Date.parse('2026-08-04T12:07:00.000Z'),
    policies,
  );
  assert.equal(plan.due.length, 1);
  assert.equal(plan.due[0].scheduledAt, '2026-08-04T12:00:00.000Z');
});

test('a firing at the latest obligation needs no catch-up, even when it failed', () => {
  const policies = [
    { job: 'cron 0 * * * *', expression: '0 * * * *', kind: 'cron', maxAgeMs: 2 * 60 * 60 * 1000 },
  ];
  const plan = startupCatchupPlan(
    ['0 * * * *'],
    [{ at: '2026-08-04T12:00:00.005Z', job: 'cron 0 * * * *', outcome: 'failed', ms: 1 }],
    Date.parse('2026-08-04T12:07:00.000Z'),
    policies,
  );
  assert.equal(plan.due.length, 0, 'downtime recovery must not become an immediate failure retry loop');
});

test('an expired obligation waits for its next schedule instead of running stale work', () => {
  const policies = [
    { job: 'backup', expression: '0 4 * * *', kind: 'backup', maxAgeMs: 2 * 60 * 60 * 1000 },
  ];
  const plan = startupCatchupPlan([], [], Date.parse('2026-08-04T12:07:00.000Z'), policies);
  assert.equal(plan.due.length, 0);
  assert.match(plan.excluded[0].reason, /older than the 2h recovery window/u);
});

test('an unknown cron is excluded because no scheduled job runs on it', () => {
  const plan = startupCatchupPlan(
    ['13 13 * * *'],
    [],
    Date.parse('2026-08-04T13:14:00.000Z'),
    [],
  );
  assert.deepEqual(plan.due, []);
  assert.deepEqual(plan.excluded, [
    {
      expression: '13 13 * * *',
      reason: 'unknown cron excluded: no scheduled job runs on it',
    },
  ]);
});

test('regular schedules stand down only on the lane startup recovery still owns', () => {
  assert.deepEqual(scheduledDuringCatchupDecision(true, 'cron */15 * * * *'), {
    run: false,
    outcome: 'skipped',
    detail: 'startup catch-up in progress',
    text: "regular cron */15 * * * * tick held while startup catch-up still owns that lane's recovery",
  });
  assert.deepEqual(scheduledDuringCatchupDecision(false, 'backup'), {
    run: true,
    outcome: null,
    detail: null,
    text: null,
  });
});

test('catch-up ownership holds its own lanes and nobody else, and lets each go as it finishes', () => {
  const ownership = createCatchupOwnership();
  ownership.own(['cron 45 12 * * 1', 'cron */15 * * * *']);
  assert.equal(ownership.holds('cron 45 12 * * 1'), true);
  assert.equal(ownership.holds('cron */15 * * * *'), true);
  // A long weekly lane must not hold every lane on the machine, including
  // lanes the plan never contained.
  assert.equal(ownership.holds('cron 10,30,50 * * * *'), false);
  assert.equal(ownership.holds('beads-snapshot'), false);
  assert.equal(ownership.size, 2);

  ownership.release('cron */15 * * * *');
  assert.equal(ownership.holds('cron */15 * * * *'), false, 'a paid lane returns to its own schedule at once');
  assert.equal(ownership.holds('cron 45 12 * * 1'), true, 'the lane still owed stays held');
  assert.equal(ownership.size, 1);

  ownership.clear();
  assert.equal(ownership.holds('cron 45 12 * * 1'), false);
  assert.equal(ownership.size, 0);
});

test('catch-up pays the cheapest cadence first, so the wall never queues behind a weekly collection', () => {
  const policies = [
    { job: 'cron 45 12 * * 1', expression: '45 12 * * 1', kind: 'cron', maxAgeMs: 8 * 24 * 60 * 60 * 1000 },
    { job: 'cron 15 12 * * *', expression: '15 12 * * *', kind: 'cron', maxAgeMs: 36 * 60 * 60 * 1000 },
    { job: 'cron 10,30,50 * * * *', expression: '10,30,50 * * * *', kind: 'cron', maxAgeMs: 36 * 60 * 60 * 1000 },
    { job: 'cron */15 * * * *', expression: '*/15 * * * *', kind: 'cron', maxAgeMs: 60 * 60 * 1000 },
  ];
  // A Monday, so the weekly lane is genuinely due alongside the rest.
  const plan = startupCatchupPlan(
    policies.map((policy) => policy.expression),
    [],
    Date.parse('2026-09-14T12:55:00.000Z'),
    policies,
  );
  assert.deepEqual(plan.due.map((item) => item.job), [
    'cron */15 * * * *',
    'cron 10,30,50 * * * *',
    'cron 15 12 * * *',
    'cron 45 12 * * 1',
  ]);
  assert.deepEqual(plan.due.map((item) => item.intervalMs), [
    15 * 60_000,
    20 * 60_000,
    24 * 60 * 60_000,
    7 * 24 * 60 * 60_000,
  ]);
});

test("the vite plugin's fallback door port matches the port map", () => {
  // A bare `pnpm --filter @noticeos/tower dev` gets the fallback rather than
  // this env, so a drift there would open the ingest somewhere the runner never
  // knocks — and would not fail until a cron silently stopped landing.
  const source = readFileSync(
    path.join(REPO_ROOT, 'apps', 'tower', 'vite', 'runner-door.ts'),
    'utf8',
  );
  const match = /DEFAULT_DOOR_PORT = (\d+)/.exec(source);
  assert.ok(match, 'apps/tower/vite/runner-door.ts must export DEFAULT_DOOR_PORT');
  assert.equal(Number(match[1]), CONFIG.ingestPort);
});

// The job-run record. A log cannot prove an absence ("did the nightly backup
// run last night?"), so each firing leaves a line the runner reads back at
// startup.

const RUN_AT = Date.parse('2026-08-04T04:00:00.000Z');

function record(over = {}) {
  return jobRunRecord({
    job: 'backup',
    outcome: 'ran',
    startedAtMs: RUN_AT,
    finishedAtMs: RUN_AT + 12_000,
    ...over,
  });
}

test('a firing is recorded with what it was, when, and how long it took', () => {
  assert.deepEqual(record(), {
    at: '2026-08-04T04:00:00.000Z',
    job: 'backup',
    outcome: 'ran',
    ms: 12_000,
  });
});

test('an outcome the record does not recognise is a failure, not a new state', () => {
  // A lane that answers something unexpected has not proven it worked, and the
  // whole point of this record is that success has to be earned.
  assert.equal(record({ outcome: 'probably fine' }).outcome, 'failed');
  assert.deepEqual(JOB_RUN_OUTCOMES, ['ran', 'skipped', 'failed']);
});

test('a detail is kept, flattened and bounded', () => {
  const long = record({ outcome: 'failed', detail: `boom\n  at ${'x'.repeat(400)}` });
  assert.match(long.detail, /^boom at x+$/);
  assert.equal(long.detail.length, 200);
  // No detail is no field, rather than a null nobody reads.
  assert.equal('detail' in record(), false);
});

test('the record survives a line torn by a SIGKILL mid-write', () => {
  // This file is appended by a process that can be killed at any moment, so a
  // half-written last line is a normal thing to find on the next startup.
  const text = `${jobRunLine(record())}${jobRunLine(record({ job: 'push-state' }))}{"at":"2026-08`;
  const parsed = parseJobRuns(text);
  assert.deepEqual(parsed.map((r) => r.job), ['backup', 'push-state']);
});

test('the record answers what each lane last did, and how often', () => {
  const summary = summarizeJobRuns([
    record({ job: 'beads-snapshot', startedAtMs: RUN_AT }),
    record({ job: 'beads-snapshot', outcome: 'skipped', startedAtMs: RUN_AT + 60_000 }),
    record({ job: 'cron 45 12 * * 1', outcome: 'failed', startedAtMs: RUN_AT - 3_600_000 }),
  ]);
  assert.deepEqual(summary.map((s) => s.job), ['beads-snapshot', 'cron 45 12 * * 1']);
  const poll = summary[0];
  assert.equal(poll.lastOutcome, 'skipped');
  assert.equal(poll.last, new Date(RUN_AT + 60_000).toISOString());
  assert.equal(poll.ran, 1);
  assert.equal(poll.skipped, 1);
  // A skip is counted, never swallowed: a lane that stood down every tick for a
  // week is a finding, and it looks identical to a healthy one in a log.
  assert.equal(summary[1].failed, 1);
});

test('an out-of-order append does not rewrite what “last” means', () => {
  // Two lanes can finish out of order, and a slow append must not make an older
  // firing the newest one.
  const summary = summarizeJobRuns([
    record({ job: 'backup', startedAtMs: RUN_AT }),
    record({ job: 'backup', outcome: 'failed', startedAtMs: RUN_AT - 86_400_000 }),
  ]);
  assert.equal(summary[0].lastOutcome, 'ran');
  assert.equal(summary[0].last, '2026-08-04T04:00:00.000Z');
});

test('history older than the window is dropped by date, not by line count', () => {
  const cutoff = jobRunCutoff(RUN_AT);
  assert.equal(cutoff, new Date(RUN_AT - JOB_RUN_RETENTION_DAYS * 86_400_000).toISOString());
  const kept = pruneJobRuns(
    [
      record({ startedAtMs: RUN_AT - 40 * 86_400_000 }),
      record({ startedAtMs: RUN_AT - 2 * 86_400_000 }),
    ],
    cutoff,
  );
  assert.equal(kept.length, 1);
});

test('a startup reads the record out loud, so a dead lane is visible', () => {
  const summary = summarizeJobRuns([
    record({ job: 'backup', startedAtMs: RUN_AT - 9 * 3_600_000 }),
    record({ job: 'cron 45 12 * * 1', startedAtMs: RUN_AT - 9 * 86_400_000 }),
  ]);
  const [line] = jobRunStartupLines(summary, RUN_AT, '.local/logs/job-runs.jsonl');
  assert.equal(line.level, 'INFO');
  assert.match(line.text, /backup ran 9h ago/);
  // The weekly collection nine days silent — a cron death, legible from the
  // record instead of inferred from an absence of log lines.
  assert.match(line.text, /cron 45 12 \* \* 1 ran 9d ago/);
  assert.match(line.text, /\.local\/logs\/job-runs\.jsonl/);
});

test('a lane whose last firing failed is its own warning', () => {
  const lines = jobRunStartupLines(
    summarizeJobRuns([record({ job: 'panel-refresh', outcome: 'failed', startedAtMs: RUN_AT - 7_200_000 })]),
    RUN_AT,
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[1].level, 'WARN');
  assert.match(lines[1].text, /panel-refresh \(last 2h ago\) last FAILED/);
});

test('an empty record says empty, because “nothing recorded” is not “nothing ran”', () => {
  const [line] = jobRunStartupLines([], RUN_AT);
  assert.equal(line.level, 'INFO');
  assert.match(line.text, /empty — nothing recorded yet/);
});

/** A lane run against a throwaway ledger, so the round trip — fire, append,
 * read back — is exercised rather than assumed. */
function laneDeps() {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-up-jobruns-'));
  const file = path.join(dir, 'job-runs.jsonl');
  const lines = [];
  return {
    file,
    lines,
    deps: { file, emit: (level, text) => lines.push(`${level} ${text}`) },
    read: () => parseJobRuns(existsSync(file) ? readFileSync(file, 'utf8') : ''),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('a lane that did its pass leaves a “ran” line behind', async () => {
  const lane = laneDeps();
  try {
    const result = await runJobLane('panel-review', () => Promise.resolve({ filed: [] }), undefined, lane.deps);
    assert.deepEqual(result, { filed: [] });
    const [entry] = lane.read();
    assert.equal(entry.job, 'panel-review');
    assert.equal(entry.outcome, 'ran');
    assert.ok(typeof entry.at === 'string' && entry.at.endsWith('Z'));
  } finally {
    lane.cleanup();
  }
});

test('a lane that stood down leaves evidence of standing down', async () => {
  // The convention every lane here already follows: null means it did not run
  // (a down ingest, an unreachable hub). Recording that is the whole point —
  // "skipped every tick for a week" is invisible in a log and obvious here.
  const lane = laneDeps();
  try {
    await runJobLane('beads-snapshot', () => Promise.resolve(null), undefined, lane.deps);
    assert.equal(lane.read()[0].outcome, 'skipped');
  } finally {
    lane.cleanup();
  }
});

test('a lane that threw is recorded as failed, with the reason, and does not spread', async () => {
  const lane = laneDeps();
  try {
    const result = await runJobLane(
      'backup',
      () => Promise.reject(new Error('sqlite3 not found')),
      undefined,
      lane.deps,
    );
    // The throw is absorbed: one bad tick never takes the runner or the next
    // tick with it.
    assert.equal(result, null);
    const [entry] = lane.read();
    assert.equal(entry.outcome, 'failed');
    assert.match(entry.detail, /sqlite3 not found/);
    assert.match(lane.lines[0], /^ERROR job "backup" failed: sqlite3 not found/);
  } finally {
    lane.cleanup();
  }
});

test('a cron fire records its own verdict, not the wrapper’s guess', async () => {
  // fireScheduled reports ran/skipped/failed itself — a 500 from the ingest is a
  // failed firing even though the lane returned normally.
  const lane = laneDeps();
  try {
    await runJobLane(
      'cron 0 4 * * *',
      () => Promise.resolve({ outcome: 'failed', detail: 'HTTP 500' }),
      (result) => result,
      lane.deps,
    );
    const [entry] = lane.read();
    assert.equal(entry.outcome, 'failed');
    assert.equal(entry.detail, 'HTTP 500');
  } finally {
    lane.cleanup();
  }
});

test('a restart reads the record back and prunes what aged out', async () => {
  const lane = laneDeps();
  try {
    await runJobLane('backup', () => Promise.resolve('done'), () => 'ran', {
      ...lane.deps,
      now: () => RUN_AT - 40 * 86_400_000,
    });
    await runJobLane('backup', () => Promise.resolve('done'), () => 'ran', {
      ...lane.deps,
      now: () => RUN_AT - 3_600_000,
    });
    const kept = await reportJobRuns(RUN_AT, lane.deps);
    // The 40-day-old firing is gone from the file, not merely from the summary.
    assert.equal(kept.length, 1);
    assert.equal(lane.read().length, 1);
    assert.match(lane.lines[0], /INFO job-run record — 1 lane\(s\): backup ran 1h ago/);
  } finally {
    lane.cleanup();
  }
});

test('a missing record file is a first run, never a crash', async () => {
  const lane = laneDeps();
  try {
    assert.deepEqual(await reportJobRuns(RUN_AT, lane.deps), []);
    assert.match(lane.lines[0], /empty — nothing recorded yet/);
  } finally {
    lane.cleanup();
  }
});

// Shipping the record into the store. The disk half above is the record;
// `job_runs` is its mirror, and asset #0 derives `cronRunSuccess` from the
// mirror. The runner is the only writer because it is the only witness, so every
// rule here is about a door that may be shut.

/** A runtime the shipper will talk to, and one it will not. */
const upRuntime = { running: true, ready: true };
const downRuntime = { running: true, ready: false };

function shipDeps(over = {}) {
  const posted = [];
  const lines = [];
  const state = { runtime: upRuntime, pending: [], skipping: null };
  return {
    posted,
    lines,
    state,
    deps: {
      state,
      post: async (url, init) => {
        posted.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 201, text: async () => '' };
      },
      readToken: async () => 'operator-token',
      emit: (level, text) => lines.push(`${level} ${text}`),
      url: 'http://127.0.0.1:8791/api/job-runs',
      stopped: () => false,
      ...over,
    },
  };
}

test('the record ships to the door the operator bearer already opens', () => {
  assert.equal(jobRunsUrl(CONFIG), `http://${CONFIG.ingestHost}:${CONFIG.ingestPort}/api/job-runs`);
});

test('the wire carries the measured duration, not a second timestamp', () => {
  // `ms` is what the runner measured; the store derives the finish once, so it
  // can never hold two timestamps that disagree with the duration between them.
  assert.deepEqual(jobRunPostBody([record({ outcome: 'failed', detail: 'HTTP 500' })]), {
    runs: [
      {
        job: 'backup',
        startedAt: '2026-08-04T04:00:00.000Z',
        ms: 12_000,
        outcome: 'failed',
        detail: 'HTTP 500',
      },
    ],
  });
  // No detail is no field — the same absence the disk record keeps.
  assert.equal('detail' in jobRunPostBody([record()]).runs[0], false);
});

test('a torn line never travels: one bad record would 422 every good one beside it', () => {
  assert.equal(jobRunShippable(record()), true);
  assert.equal(jobRunShippable({ job: 'backup', at: '2026-08-04T04:00:00.000Z' }), false);
  assert.equal(jobRunShippable({ ...record(), outcome: 'probably fine' }), false);
});

test('a restart re-sends what is recent PLUS every lane’s last known firing', () => {
  // A weekly collection that failed five days ago is exactly the death this
  // record exists to show, and a flat time window would drop it.
  const catchup = jobRunCatchup(
    [
      record({ job: 'beads-snapshot', startedAtMs: RUN_AT - 3_600_000 }),
      record({ job: 'beads-snapshot', startedAtMs: RUN_AT - 30 * 60_000 }),
      record({ job: 'cron 45 12 * * 1', outcome: 'failed', startedAtMs: RUN_AT - 5 * 86_400_000 }),
      record({ job: 'cron 45 12 * * 1', startedAtMs: RUN_AT - 12 * 86_400_000 }),
      { job: 'torn', at: '2026-08-04T03:00:00.000Z' },
    ],
    RUN_AT,
  );
  assert.deepEqual(
    catchup.map((r) => `${r.job} ${r.at}`),
    [
      'cron 45 12 * * 1 2026-07-30T04:00:00.000Z',
      'beads-snapshot 2026-08-04T03:00:00.000Z',
      'beads-snapshot 2026-08-04T03:30:00.000Z',
    ],
  );
  // Oldest first, so a drained queue leaves the newest facts in the store even
  // if the door closes mid-catch-up.
  assert.equal(JOB_RUN_CATCHUP_DAYS, 2);
});

test('the queue is bounded, and drops the oldest — the disk still holds them', () => {
  const pending = [record({ startedAtMs: RUN_AT - 60_000 }), record({ startedAtMs: RUN_AT })];
  assert.equal(jobRunQueued(pending, record({ job: 'new' }), 2).length, 2);
  assert.equal(jobRunQueued(pending, record({ job: 'new' }), 2)[1].job, 'new');
  assert.equal(JOB_RUN_PENDING_MAX, 5_000);
});

test('a firing reaches the store as one batch beside its disk line', async () => {
  const ship = shipDeps();
  assert.equal(await shipJobRuns(record(), ship.deps), 1);
  assert.equal(ship.posted.length, 1);
  assert.equal(ship.posted[0].url, 'http://127.0.0.1:8791/api/job-runs');
  assert.equal(ship.posted[0].body.runs[0].job, 'backup');
  // Shipped means dequeued: nothing re-sends what the store confirmed.
  assert.deepEqual(ship.state.pending, []);
});

test('a door that is down costs the store nothing — the record catches up next firing', async () => {
  const ship = shipDeps({ state: { runtime: downRuntime, pending: [], skipping: null } });
  assert.equal(await shipJobRuns(record(), ship.deps), null);
  assert.equal(ship.posted.length, 0);
  // The firing is queued, not lost, and the outage says so exactly once.
  assert.equal(ship.deps.state.pending.length, 1);
  assert.equal(await shipJobRuns(record({ job: 'panel-review' }), ship.deps), null);
  assert.equal(ship.deps.state.pending.length, 2);
  assert.equal(ship.lines.filter((l) => l.startsWith('WARN')).length, 1);

  // The door opens: everything queued goes in one batch, and the resume is said.
  ship.deps.state.runtime = upRuntime;
  assert.equal(await shipJobRuns(null, ship.deps), 2);
  assert.deepEqual(
    ship.posted[0].body.runs.map((r) => r.job),
    ['backup', 'panel-review'],
  );
  assert.match(ship.lines.at(-1), /INFO job-run shipping resumed/);
});

test('an unarmed runner writes to disk and ships nothing', async () => {
  // `pnpm os:up --backup` by hand: there is no runtime to ask, so the firing is
  // disk-only and the next startup's catch-up carries it.
  const ship = shipDeps({ state: { runtime: null, pending: [], skipping: null } });
  assert.equal(await shipJobRuns(record(), ship.deps), null);
  assert.equal(ship.posted.length, 0);
  assert.equal(ship.deps.state.pending.length, 1);
});

test('a batch is bounded, and the rest of the queue waits its turn', async () => {
  const ship = shipDeps();
  ship.state.pending = Array.from({ length: JOB_RUN_SHIP_MAX + 3 }, (_, i) =>
    record({ startedAtMs: RUN_AT - i * 60_000 }),
  );
  assert.equal(await shipJobRuns(null, ship.deps), JOB_RUN_SHIP_MAX);
  assert.equal(ship.state.pending.length, 3);
});

test('a body the store refuses is dropped, not re-sent forever', async () => {
  // A 422 is the store having validated the bytes and said no. Re-sending them
  // every minute would jam the queue behind a record that is never going to be
  // accepted — and the disk file is still the record either way.
  const ship = shipDeps({
    post: async () => ({ ok: false, status: 422, text: async () => '{"error":"validation"}' }),
  });
  assert.equal(await shipJobRuns(record(), ship.deps), 0);
  assert.deepEqual(ship.state.pending, []);
  assert.match(ship.lines[0], /ERROR job-run shipping dropped 1 record\(s\)/);
});

test('a 500 keeps the queue, because that record may still land', async () => {
  const ship = shipDeps({
    post: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
  });
  assert.equal(await shipJobRuns(record(), ship.deps), null);
  assert.equal(ship.state.pending.length, 1);
  assert.match(ship.lines[0], /WARN job-run shipping paused — HTTP 500 boom/);
});

test('a door that does not answer is an outage, never an exception', async () => {
  // This runs inside runJobLane: a record of the work must never stop the work.
  const ship = shipDeps({
    post: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(await shipJobRuns(record(), ship.deps), null);
  assert.equal(ship.state.pending.length, 1);
  assert.match(ship.lines[0], /WARN job-run shipping paused — the ingest door did not answer/);
});

test('a lane both writes its line and ships it, in that order', async () => {
  const lane = laneDeps();
  const shipped = [];
  try {
    await runJobLane('backup', () => Promise.resolve('done'), () => 'ran', {
      ...lane.deps,
      ship: (entry) => shipped.push(entry),
    });
    // The append is what makes the firing a fact; the ship is what makes it
    // readable by a Worker — and the ship only ever sees a record already on
    // disk.
    assert.equal(lane.read().length, 1);
    assert.deepEqual(shipped.map((e) => e.job), ['backup']);
  } finally {
    lane.cleanup();
  }
});

test('arming seeds the queue from the record the last runner left behind', () => {
  const state = { runtime: null, pending: [], skipping: null };
  const queued = armJobRunShipping(
    upRuntime,
    [
      record({ job: 'backup', startedAtMs: RUN_AT - 3_600_000 }),
      record({ job: 'backup', startedAtMs: RUN_AT - 20 * 86_400_000 }),
      record({ job: 'cron 45 12 * * 1', startedAtMs: RUN_AT - 6 * 86_400_000 }),
    ],
    RUN_AT,
    state,
  );
  // Last night's backup, and the weekly lane's only firing however old — but not
  // the backup from three weeks ago, which changes no answer the store gives.
  assert.equal(queued, 2);
  assert.deepEqual(
    state.pending.map((r) => r.job),
    ['cron 45 12 * * 1', 'backup'],
  );
  assert.equal(state.runtime, upRuntime);
});

// Door ownership. Two runners started in the same second both see a FREE port
// and both proceed; `child.ready` is a liveness fact (vite's banner prints
// before the door binds), so a tick has to prove its own child holds the door
// before it fires anything at it.

test('the ownership probe asks about the pinned door port, in machine format', () => {
  assert.deepEqual(listenerOwnersArgs(CONFIG.ingestPort), [
    '-nP',
    `-iTCP:${CONFIG.ingestPort}`,
    '-sTCP:LISTEN',
    '-F',
    'pg',
  ]);
  // The refusal routes the operator through the standard diagnosis command.
  assert.match(runnerArmDecision({ ingestPortAnswers: true }, CONFIG).text, /pnpm os:doctor/);
});

test('lsof field output reads back as pid + process group', () => {
  assert.deepEqual(parseListenerOwners('p1289\ng1289\nf4\nn127.0.0.1:8791\n'), [
    { pid: 1289, pgid: 1289 },
  ]);
  // Several listeners, and a process whose group is its parent's rather than
  // its own — which is exactly the vite-under-pnpm case this exists to catch.
  assert.deepEqual(parseListenerOwners('p900\ng900\nf5\np941\ng900\nf7\n'), [
    { pid: 900, pgid: 900 },
    { pid: 941, pgid: 900 },
  ]);
});

test('an owner we cannot place in a process group is not an owner', () => {
  // Half an answer cannot answer the only question being asked.
  assert.deepEqual(parseListenerOwners('p1289\nf4\nn127.0.0.1:8791\n'), []);
  assert.deepEqual(parseListenerOwners(''), []);
  assert.deepEqual(parseListenerOwners(null), []);
});

test('a listener in our child’s process group is our door', () => {
  const d = doorOwnershipDecision({ owners: [{ pid: 941, pgid: 900 }], group: 900 }, CONFIG);
  assert.equal(d.owns, true);
  assert.match(d.reason, /941/);
  assert.match(d.reason, /127\.0\.0\.1:8791/);
});

test('a listener in somebody else’s group is somebody else’s door', () => {
  const d = doorOwnershipDecision({ owners: [{ pid: 4242, pgid: 4200 }], group: 900 }, CONFIG);
  assert.equal(d.owns, false);
  // Both groups named: the operator has to be able to tell which process to stop.
  assert.match(d.reason, /4242/);
  assert.match(d.reason, /4200/);
  assert.match(d.reason, /900/);
});

test('a listener that left our process group is still our process tree', () => {
  // The group check assumes a detached spawn leads the group its vite and
  // workerd inherit; a foreign GROUP is re-checked against the process TREE
  // before anything stands down, so a broken assumption cannot stand every
  // cron down forever.
  const parents = parseProcessParents(' 941 933\n 933 900\n 900 1\n');
  const d = doorOwnershipDecision(
    { owners: [{ pid: 941, pgid: 941 }], group: 900, parents },
    CONFIG,
  );
  assert.equal(d.owns, true);
  assert.match(d.reason, /descendant of this runner's ingest child 900/);
});

test('somebody else’s tree is still somebody else’s', () => {
  const parents = parseProcessParents(' 4242 4200\n 4200 1\n 900 1\n');
  const d = doorOwnershipDecision(
    { owners: [{ pid: 4242, pgid: 4242 }], group: 900, parents },
    CONFIG,
  );
  assert.equal(d.owns, false);
});

test('ancestry never loops, whatever ps says', () => {
  // A parent map that points at itself (or in a cycle) must terminate: this runs
  // on the cron path, and a hang here stops every schedule.
  const looped = parseProcessParents(' 10 11\n 11 10\n');
  assert.equal(isDescendantOf(10, 900, looped), false);
  assert.equal(isDescendantOf(10, 11, looped), true);
  // pid 1 is the top: launchd is not "our tree" however far up you walk.
  assert.equal(isDescendantOf(941, 1, parseProcessParents(' 941 1\n')), false);
});

test('a silent door belongs to nobody, which is not permission to fire', () => {
  const d = doorOwnershipDecision({ owners: [], group: 900 }, CONFIG);
  assert.equal(d.owns, false);
  assert.match(d.reason, /nothing is listening/);
});

test('a runner with no child owns nothing', () => {
  assert.equal(doorOwnershipDecision({ owners: [], group: null }, CONFIG).owns, false);
});

test('an unanswerable probe is unknown, never a false positive either way', () => {
  const d = doorOwnershipDecision({ owners: null, group: 900 }, CONFIG);
  assert.equal(d.owns, null);
  assert.match(d.reason, /lsof did not answer/);
});

test('a tick whose child does not hold the door is inert, and says why', () => {
  const d = cronFireDecision(
    {
      running: true,
      ready: true,
      ownership: doorOwnershipDecision({ owners: [{ pid: 4242, pgid: 4200 }], group: 900 }, CONFIG),
    },
    '45 12 * * 1',
  );
  assert.equal(d.fire, false);
  assert.equal(d.outcome, 'skipped');
  // ERROR: two runners is a billing event, not a note.
  assert.equal(d.level, 'ERROR');
  assert.match(d.text, /STANDING DOWN/);
  assert.match(d.text, /45 12 \* \* 1/);
  assert.match(d.text, /double-fire/);
  // Nothing fired, and the tick is not lost — the owner's scheduler has it.
  assert.match(d.text, /Nothing was fired/);
  assert.match(d.text, /lsof -nP -iTCP:8791 -sTCP:LISTEN/);
});

test('a tick whose child does hold the door fires without a word', () => {
  const d = cronFireDecision(
    {
      running: true,
      ready: true,
      ownership: doorOwnershipDecision({ owners: [{ pid: 941, pgid: 900 }], group: 900 }, CONFIG),
    },
    '0 * * * *',
  );
  assert.equal(d.fire, true);
  assert.equal(d.outcome, 'ran');
  assert.equal(d.level, null);
});

test('a runner that cannot check keeps firing, loudly', () => {
  // The failure mode of failing closed here is every cron in the portfolio
  // stopping because a diagnostic binary moved — worse than the race it guards.
  const d = cronFireDecision(
    { running: true, ready: true, ownership: { owns: null, reason: 'could not ask who holds it' } },
    '0 4 * * *',
  );
  assert.equal(d.fire, true);
  assert.equal(d.level, 'WARN');
  assert.match(d.text, /firing anyway/);
});

test('a down or restarting ingest still skips without replay', () => {
  const down = cronFireDecision({ running: false, ready: false, ownership: null }, '0 3 * * *');
  assert.equal(down.fire, false);
  assert.equal(down.outcome, 'skipped');
  assert.match(down.text, /down\/restarting/);
  assert.match(down.text, /no replay/);
  // Readiness alone is no longer permission: an unchecked runtime does not fire
  // silently, it fires with the unproven-ownership warning.
  const unchecked = cronFireDecision({ running: true, ready: true, ownership: null }, '0 3 * * *');
  assert.equal(unchecked.level, 'WARN');
});

test('a reachable hub reports where it is, once', () => {
  const line = beadsHubHealthLine(true, { beadsHubHost: '127.0.0.1', beadsHubPort: 3308 });
  assert.equal(line.level, 'INFO');
  assert.match(line.text, /127\.0\.0\.1:3308/);
});

test('a down hub warns with the command that fixes it', () => {
  // os:up cannot restart the hub, so the line has to hand over the fix.
  const line = beadsHubHealthLine(false, { beadsHubHost: '127.0.0.1', beadsHubPort: 3308 });
  assert.equal(line.level, 'WARN');
  assert.match(line.text, /brew services start dolt/);
  assert.match(line.text, /127\.0\.0\.1:3308/);
});

test('the beads hub is never expected beyond loopback', () => {
  // root-with-no-password is only safe while nothing off-machine can connect.
  assert.equal(CONFIG.beadsHubHost, '127.0.0.1');
});

/** Settings only — comments differ between the repo copy and the installed one
 * by design, and prose has never bound a port. */
function yamlSettings(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*(#|$)/.test(l))
    .map((l) => l.trimEnd());
}

const FIXTURE_DOLT_CONFIG = path.join(REPO_ROOT, 'scripts', 'fixture-config', 'dolt-server.yaml');
const FIXTURE_BEADS_MAP = path.join(REPO_ROOT, 'scripts', 'fixture-config', 'beads.json');

test('runner tests cannot read real installation or product settings', () => {
  const testFile = fileURLToPath(import.meta.url);
  for (const file of ['config/beads.json', 'installation/beads.json', 'installation/dolt-server.yaml']) {
    assert.equal(mayReadOwnerConfig(testFile, file), false, file);
  }
});

test('the synthetic hub map, server config and runner port agree', () => {
  const map = JSON.parse(readFileSync(FIXTURE_BEADS_MAP, 'utf8'));
  assert.equal(map.hub.port, CONFIG.beadsHubPort);
  assert.equal(map.hub.host, CONFIG.beadsHubHost);

  // Parsed narrowly on purpose: a YAML dep to read three lines is not worth it.
  const settings = yamlSettings(readFileSync(FIXTURE_DOLT_CONFIG, 'utf8'));
  assert.ok(settings.some((l) => l.trim() === `port: ${CONFIG.beadsHubPort}`));
  assert.ok(settings.some((l) => l.trim() === `host: ${CONFIG.beadsHubHost}`));
  // The data lives in the checkout's gitignored .local/, wherever it is.
  assert.ok(settings.some((l) => /^data_dir: \/.+\/\.local\/beads-dolt$/.test(l.trim())));
});

test('a synthetic server config copy matches settings, detects drift and refuses absence', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'hub-config-fixture-'));
  try {
    const copy = path.join(home, 'server.yaml');
    const source = readFileSync(FIXTURE_DOLT_CONFIG, 'utf8');
    writeFileSync(copy, '# synthetic copied configuration\n' + source);
    assert.deepEqual(yamlSettings(readFileSync(copy, 'utf8')), yamlSettings(source));
    writeFileSync(copy, source.replace('port: 3308', 'port: 3399'));
    assert.notDeepEqual(yamlSettings(readFileSync(copy, 'utf8')), yamlSettings(source));
    rmSync(copy);
    assert.throws(() => readFileSync(copy, 'utf8'), { code: 'ENOENT' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** A frozen copy of the task-hub map, never the checkout's own: the operator
 * adds and removes spokes from /settings, and that must not change a result
 * here. */
test('every configured spoke carries its task database', () => {
  const raw = readFileSync(FIXTURE_BEADS_MAP, 'utf8');
  assert.deepEqual(parseBeadsProjects(raw).map((project) => project.database), ['ro', 'mp', 'nom', 'pft', 'pts', 'ac', 'fin']);
});

test('what counts as a usable task database is declared once', () => {
  assert.equal(beadsDatabaseName('mp'), 'mp');
  assert.equal(beadsDatabaseName('reindex_os'), 'reindex_os');
  // Trimmed BEFORE the check, so one padded value is not usable to one reader
  // and unusable to the next.
  assert.equal(beadsDatabaseName('  mp  '), 'mp');
  assert.equal(beadsDatabaseName('nom; DROP DATABASE mp'), null);
  assert.equal(beadsDatabaseName('mp-food'), null);
  assert.equal(beadsDatabaseName(''), null);
  assert.equal(beadsDatabaseName('   '), null);
  assert.equal(beadsDatabaseName(42), null);
  assert.equal(beadsDatabaseName(undefined), null);
});

test('the poller and the drift check agree on every spoke', () => {
  // The whole point of one declaration: the same file read two ways cannot
  // produce two different opinions about which database is usable.
  const raw = JSON.stringify({
    spokes: [
      { asset: 'meals.example', prefix: 'mp', repo: '../meals.example', database: ' mp ' },
      { asset: 'nosh.example', prefix: 'nom', repo: '../nom', database: 'nom; DROP' },
      { asset: 'areas.example', prefix: 'ac', repo: '../areas.example' },
    ],
  });
  const carried = parseBeadsProjects(raw).map((project) => project.database);
  assert.deepEqual(carried, ['mp', null, null]);
  // A spoke with no usable name is exactly a spoke the drift check reports
  // with no declared name — nothing in between, and nothing missed.
  assert.deepEqual(
    beadsDatabaseDrift(parseBeadsProjects(raw), new Set(['mp'])).map((entry) => [
      entry.asset,
      entry.declared,
    ]),
    [
      ['nosh.example', null],
      ['areas.example', null],
    ],
  );
});

test('spoke database names that could not be safely interpolated travel as null', () => {
  const databases = ['mp', 'nom; DROP DATABASE mp', '', 42, undefined, 'mp'];
  const raw = JSON.stringify({
    spokes: databases.map((database, index) => ({ asset: `s${index}.example`, prefix: `s${index}`, repo: `../s${index}`, database })),
  });
  assert.deepEqual(parseBeadsProjects(raw).map((project) => project.database), ['mp', null, null, null, null, 'mp']);
});

test('an explicit binary override outranks anything on disk', () => {
  const exists = () => true;
  assert.equal(resolveBin('/custom/dolt', ['/opt/homebrew/bin/dolt'], exists, 'dolt'), '/custom/dolt');
  assert.equal(resolveBin('  ', ['/opt/homebrew/bin/dolt'], exists, 'dolt'), '/opt/homebrew/bin/dolt');
});

test('binary resolution prefers a known install over launchd’s bare PATH', () => {
  const only = (want) => (candidate) => candidate === want;
  assert.equal(
    resolveBin(undefined, ['/opt/homebrew/bin/dolt', '/usr/local/bin/dolt'], only('/usr/local/bin/dolt'), 'dolt'),
    '/usr/local/bin/dolt',
  );
  assert.equal(resolveBin(undefined, ['/opt/homebrew/bin/dolt'], () => false, 'dolt'), 'dolt');
});

// The runner's commands (bd, git, lsof, ps, pgrep, the panel refresh) go
// through scripts/run-command.mjs. A bd whose answer is still in the pipe when
// it exits must be read in full, never cut short at the exit.
test('a bd answer still arriving after bd exited is read in full', async () => {
  const late = lateWritingCommand('bd', { early: '[{"id":"ex-1",', late: '"title":"late"}]\n' });
  const saved = process.env.BEADS_BD_BIN;
  process.env.BEADS_BD_BIN = late.bin;
  try {
    const result = await runBd(['list', '--json']);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), [{ id: 'ex-1', title: 'late' }]);
  } finally {
    if (saved === undefined) delete process.env.BEADS_BD_BIN;
    else process.env.BEADS_BD_BIN = saved;
    late.remove();
  }
});

// Hub contention diagnosis: a stray `dolt sql-server` holding the port and the
// per-database write locks must be named as the cause, with the fix, rather
// than restarted around blindly.
// ─────────────────────────────────────────────────────────────────────────────

const HUB = { beadsHubHost: '127.0.0.1', beadsHubPort: 3308 };
const DATA_DIR = '/repo/.local/beads-dolt';

const server = (pid, command) => ({ pid, command });

test('pgrep output becomes pids we can name in a log line', () => {
  const stdout = [
    '78866 /opt/homebrew/opt/dolt/bin/dolt sql-server --config /opt/homebrew/etc/dolt/config.yaml',
    '68972 dolt sql-server -H 127.0.0.1 -P 3308 --data-dir /repo/.local/beads-dolt --loglevel=warning',
    '',
  ].join('\n');
  assert.deepEqual(parseDoltServers(stdout), [
    server(78866, '/opt/homebrew/opt/dolt/bin/dolt sql-server --config /opt/homebrew/etc/dolt/config.yaml'),
    server(68972, 'dolt sql-server -H 127.0.0.1 -P 3308 --data-dir /repo/.local/beads-dolt --loglevel=warning'),
  ]);
  assert.deepEqual(parseDoltServers(''), []);
  assert.deepEqual(parseDoltServers(undefined), []);
});

test('a concurrent pgrep is not a stray server, however its argv reads', () => {
  // The 15-minute cron check and the per-poll check coincide at :00/:15/:30/:45
  // and each ran `pgrep -fl "dolt sql-server"`; pgrep excludes itself but not
  // its twin, so every coinciding tick reported a phantom second server.
  const stdout = [
    '78866 /opt/homebrew/opt/dolt/bin/dolt sql-server --config /opt/homebrew/etc/dolt/config.yaml',
    '97636 /usr/bin/pgrep -fl dolt sql-server',
    '13624 grep dolt sql-server',
  ].join('\n');
  assert.deepEqual(parseDoltServers(stdout), [
    server(78866, '/opt/homebrew/opt/dolt/bin/dolt sql-server --config /opt/homebrew/etc/dolt/config.yaml'),
  ]);
});

test('one server on an open port is the healthy line, unchanged', () => {
  const d = beadsHubDiagnosis(
    { reachable: true, servers: [server(78866, 'dolt sql-server --config x')], dataDir: DATA_DIR },
    HUB,
  );
  assert.equal(d.key, 'up');
  assert.equal(d.level, 'INFO');
  assert.deepEqual({ level: d.level, text: d.text }, beadsHubHealthLine(true, HUB));
});

test('no server and a closed port is the down line, unchanged', () => {
  const d = beadsHubDiagnosis({ reachable: false, servers: [], dataDir: DATA_DIR }, HUB);
  assert.equal(d.key, 'down');
  assert.deepEqual({ level: d.level, text: d.text }, beadsHubHealthLine(false, HUB));
});

test('a stray alongside the hub is named, with both pids and the fix', () => {
  // The port is OPEN here — which is exactly the trap. A bare probe reports a
  // green "reachable" line while the loser of the lock race crash-loops.
  const d = beadsHubDiagnosis(
    {
      reachable: true,
      servers: [server(78866, 'dolt sql-server --config x'), server(68972, 'dolt sql-server --data-dir y')],
      dataDir: DATA_DIR,
    },
    HUB,
  );
  assert.equal(d.key, 'contended');
  assert.equal(d.level, 'WARN');
  assert.match(d.text, /CONTENDED/);
  assert.match(d.text, /pids 78866, 68972/);
  assert.match(d.text, /exclusive write lock per database/);
  assert.match(d.text, new RegExp(DATA_DIR));
  // The operator gets the identify step AND the repair step, not a symptom.
  assert.match(d.text, /lsof -nP -iTCP:3308 -sTCP:LISTEN/);
  assert.match(d.text, /brew services restart dolt/);
});

test('a dead port with a live dolt is called what it is: a crash loop', () => {
  const d = beadsHubDiagnosis(
    { reachable: false, servers: [server(68972, 'dolt sql-server --data-dir y')], dataDir: DATA_DIR },
    HUB,
  );
  assert.equal(d.key, 'crash-looping');
  assert.equal(d.level, 'WARN');
  assert.match(d.text, /crash-loop signature/);
  assert.match(d.text, /pids 68972/);
  assert.match(d.text, /brew services info dolt/);
});

test('a diagnosis we could not make degrades to the plain health line', () => {
  // pgrep missing must not invent a conflict, nor suppress the basic answer.
  for (const reachable of [true, false]) {
    const d = beadsHubDiagnosis({ reachable, servers: null, dataDir: DATA_DIR }, HUB);
    assert.equal(d.key, reachable ? 'up' : 'down');
    assert.deepEqual({ level: d.level, text: d.text }, beadsHubHealthLine(reachable, HUB));
  }
});

test('every hub state is one line the operator can act on', () => {
  // No state may report a symptom without a next step, and each is distinct so
  // "log state changes only" can tell them apart.
  const cases = [
    { reachable: true, servers: [server(1, 'a')] },
    { reachable: false, servers: [] },
    { reachable: true, servers: [server(1, 'a'), server(2, 'b')] },
    { reachable: false, servers: [server(1, 'a')] },
  ];
  const keys = cases.map((c) => beadsHubDiagnosis({ ...c, dataDir: DATA_DIR }, HUB).key);
  assert.deepEqual(keys, ['up', 'down', 'contended', 'crash-looping']);
  for (const c of cases.slice(1)) {
    assert.match(beadsHubDiagnosis({ ...c, dataDir: DATA_DIR }, HUB).text, /brew services/);
  }
});

// Beads snapshot poller, the Tower work board's supply.
//
// Fixture shapes come from `bd` 1.1.2 output recorded against a throwaway
// project, with personal identifiers replaced by examples. A bd upgrade that
// renames a field breaks these rather than quietly emptying the board.

const BD_READY = JSON.stringify([
  {
    id: 'zz-135',
    title: 'Ready feature two',
    status: 'open',
    priority: 0,
    issue_type: 'feature',
    assignee: 'operator',
    owner: 'operator@example.com',
    created_at: '2026-08-01T16:30:53Z',
    created_by: 'Example Operator',
    updated_at: '2026-08-01T16:30:53Z',
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
  },
  {
    id: 'zz-4qr',
    title: 'Ready task one',
    status: 'open',
    priority: 1,
    issue_type: 'task',
    owner: 'operator@example.com',
    created_at: '2026-08-01T16:30:52Z',
    created_by: 'Example Operator',
    updated_at: '2026-08-01T16:30:52Z',
    dependency_count: 0,
    dependent_count: 1,
    comment_count: 0,
  },
]);

const BD_ACTIVE = JSON.stringify([
  JSON.parse(BD_READY)[0],
  JSON.parse(BD_READY)[1],
  {
    id: 'zz-p6y',
    title: 'Work in flight',
    status: 'in_progress',
    priority: 2,
    issue_type: 'bug',
    assignee: 'agent-x',
    owner: 'operator@example.com',
    created_at: '2026-08-01T16:30:53Z',
    created_by: 'Example Operator',
    updated_at: '2026-08-01T16:30:58Z',
    started_at: '2026-08-01T16:30:58Z',
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
  },
  {
    id: 'zz-hfl',
    title: 'Blocked thing',
    status: 'open',
    priority: 3,
    issue_type: 'chore',
    owner: 'operator@example.com',
    created_at: '2026-08-01T16:30:54Z',
    created_by: 'Example Operator',
    updated_at: '2026-08-01T16:30:54Z',
    dependencies: [
      {
        issue_id: 'zz-hfl',
        depends_on_id: 'zz-4qr',
        type: 'blocks',
        created_at: '2026-08-01T09:30:58Z',
        created_by: 'Example Operator',
        metadata: '{}',
      },
    ],
    dependency_count: 1,
    dependent_count: 0,
    comment_count: 0,
  },
]);

const BD_BLOCKED = JSON.stringify([
  {
    id: 'zz-hfl',
    title: 'Blocked thing',
    status: 'open',
    priority: 3,
    issue_type: 'chore',
    owner: 'operator@example.com',
    created_at: '2026-08-01T16:30:54Z',
    created_by: 'Example Operator',
    updated_at: '2026-08-01T16:30:54Z',
    blocked_by_count: 1,
    blocked_by: ['zz-4qr'],
  },
]);

const BD_CLOSED = JSON.stringify([
  {
    id: 'zz-0pb',
    title: 'Finished item',
    status: 'closed',
    priority: 2,
    issue_type: 'task',
    owner: 'operator@example.com',
    created_at: '2026-08-01T16:30:54Z',
    created_by: 'Example Operator',
    updated_at: '2026-08-01T16:30:59Z',
    closed_at: '2026-08-01T16:30:59Z',
    close_reason: 'Closed',
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
  },
]);

const ok = (stdout) => ({ code: 0, stdout, stderr: '' });

const FULL_RESULTS = {
  active: ok(BD_ACTIVE),
  ready: ok(BD_READY),
  blocked: ok(BD_BLOCKED),
  closed: ok(BD_CLOSED),
};

const PROJECT = { asset: 'root-os', prefix: 'ro', repo: '.' };

test('the poller reads every spoke the task map declares', () => {
  const raw = readFileSync(FIXTURE_BEADS_MAP, 'utf8');
  assert.deepEqual(
    parseBeadsProjects(raw).map((p) => `${p.asset}/${p.prefix}/${p.repo}`),
    [
      'root-os/ro/.',
      'meals.example/mp/../meals.example',
      'nosh.example/nom/../nom',
      'pacer.example/pft/../pacer.example',
      'pullups.example/pts/../pullups.example',
      'areas.example/ac/../areas.example',
      'fees.example/fin/../fees.example',
    ],
  );
});

test('a half-declared spoke is dropped rather than half-polled', () => {
  // asset, prefix and repo are all load-bearing (config/beads.README.md); a
  // spoke missing any of them cannot be joined back to a property.
  const raw = JSON.stringify({
    spokes: [
      { asset: 'meals.example', prefix: 'mp', repo: '../meals.example' },
      { asset: 'nosh.example', prefix: 'nom' },
      { prefix: 'ac', repo: '../areas.example' },
      { asset: 'fees.example', prefix: '', repo: '../fees.example' },
      { asset: 'meals.example', prefix: 'mp2', repo: '../dupe' },
    ],
  });
  assert.deepEqual(parseBeadsProjects(raw), [
    { asset: 'meals.example', prefix: 'mp', repo: '../meals.example', database: null },
  ]);
});

test('the declared database is carried, not required, and not dropped on the floor', () => {
  // The poll never uses this field (`bd` resolves the database from the repo's
  // own .beads/config.yaml), so requiring it would blank a working board over a
  // value only the backup reads. It travels, and travels as null when unusable.
  const raw = JSON.stringify({
    spokes: [
      { asset: 'meals.example', prefix: 'mp', repo: '../meals.example', database: 'mp' },
      { asset: 'nosh.example', prefix: 'nom', repo: '../nom' },
      { asset: 'areas.example', prefix: 'ac', repo: '../areas.example', database: 'ac; DROP' },
    ],
  });
  assert.deepEqual(
    parseBeadsProjects(raw).map((p) => [p.asset, p.database]),
    [
      ['meals.example', 'mp'],
      // Both still POLL: only the backup cares, and a board that vanishes is a
      // worse answer than a database name somebody has to fix.
      ['nosh.example', null],
      ['areas.example', null],
    ],
  );
});

test('a broken task map costs the snapshot nothing but the snapshot', () => {
  assert.deepEqual(parseBeadsProjects('not json at all'), []);
  assert.deepEqual(parseBeadsProjects('{}'), []);
  assert.deepEqual(parseBeadsProjects('{"spokes":"mp"}'), []);
});

test('the recent-close window is seven days, at the grain bd accepts', () => {
  assert.equal(beadsClosedSince(Date.parse('2026-08-01T09:00:00Z')), '2026-07-25');
  assert.equal(BEADS_CLOSED_WINDOW_DAYS, 7);
});

test('the four reads are bounded by repo, not by the runner’s cwd', () => {
  const args = beadsPollArgs('/repos/nom', '2026-07-25');
  for (const argv of Object.values(args)) {
    assert.deepEqual(argv.slice(0, 2), ['-C', '/repos/nom']);
    assert.ok(argv.includes('--json'));
  }
  // --limit 0 is unlimited: the COUNTS must be true even though the lists are
  // truncated afterwards.
  assert.ok(args.ready.includes('--limit') && args.ready.includes('0'));
  assert.deepEqual(args.active.slice(2), [
    'list',
    '--status',
    'open,in_progress,blocked',
    '--json',
    '--limit',
    '0',
  ]);
  assert.deepEqual(args.blocked.slice(2), ['blocked', '--json']);
  assert.ok(args.closed.includes('--closed-after') && args.closed.includes('2026-07-25'));
});

test('one project’s four reads become one board section', () => {
  const entry = summarizeBeadsProject(PROJECT, FULL_RESULTS);
  assert.equal(entry.ok, true);
  assert.equal(entry.error, null);
  assert.equal(entry.asset, 'root-os');
  assert.equal(entry.prefix, 'ro');
  assert.deepEqual(entry.counts, {
    // Three stored-`open` beads; two are claimable and one waits on a blocker.
    open: 3,
    // zz-135 is P0 and zz-4qr is P1; the in-flight bug is P2.
    highPriority: 2,
    ready: 2,
    inProgress: 1,
    blocked: 1,
    closedRecent: 1,
  });
  // bd's own ranking is preserved — re-sorting here would disagree with what
  // `bd ready` tells an agent in that repo to do next.
  assert.deepEqual(entry.ready.map((i) => i.id), ['zz-135', 'zz-4qr']);
  assert.deepEqual(entry.inProgress.map((i) => i.id), ['zz-p6y']);
  assert.deepEqual(entry.recentlyClosed.map((i) => i.id), ['zz-0pb']);
});

test('bd’s snake_case fields land as the camelCase the store speaks', () => {
  const entry = summarizeBeadsProject(PROJECT, FULL_RESULTS);
  assert.deepEqual(entry.ready[0], {
    id: 'zz-135',
    title: 'Ready feature two',
    status: 'open',
    priority: 0,
    issueType: 'feature',
    assignee: 'operator',
    updatedAt: '2026-08-01T16:30:53.000Z',
    closedAt: null,
    // When it was filed — what tells the Wall feed a new task from an old one.
    createdAt: '2026-08-01T16:30:53.000Z',
    // `parent` is bd's own field, and null means un-epiced rather than unknown.
    parent: null,
    // Only a deferred bead carries one.
    deferUntil: null,
  });
  // An unassigned bead reports null, not an empty string the UI would render.
  assert.equal(entry.ready[1].assignee, null);
  assert.equal(entry.recentlyClosed[0].closedAt, '2026-08-01T16:30:59.000Z');
});

test('a bead with no title still renders as something', () => {
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    ready: ok(JSON.stringify([{ id: 'zz-abc', title: '   ', priority: 99 }])),
  });
  assert.equal(entry.ready[0].title, 'zz-abc');
  // An out-of-range priority falls back to bd's documented default.
  assert.equal(entry.ready[0].priority, 2);
  assert.equal(entry.ready[0].status, 'open');
  assert.equal(entry.ready[0].issueType, 'task');
});

// An epic is a container (nobody claims one or closes one by doing it), so
// counting epics overstates every "how much is left?" number. This has to
// happen HERE: the counts are the only untruncated view of the hub
// (`--limit 0`), so no consumer downstream can find or subtract the epics.
test('epic containers are not work, and are counted as none of it', () => {
  const epic = (id, extra = {}) => ({
    id,
    title: `Epic ${id}`,
    status: 'open',
    priority: 0,
    issue_type: 'epic',
    ...extra,
  });
  const entry = summarizeBeadsProject(PROJECT, {
    active: ok(JSON.stringify([...JSON.parse(BD_ACTIVE), epic('zz-e1'), epic('zz-e2')])),
    ready: ok(JSON.stringify([epic('zz-e1'), ...JSON.parse(BD_READY)])),
    blocked: ok(JSON.stringify([...JSON.parse(BD_BLOCKED), epic('zz-e2')])),
    closed: ok(
      JSON.stringify([
        ...JSON.parse(BD_CLOSED),
        epic('zz-e3', { status: 'closed', closed_at: '2026-07-30T00:00:00Z' }),
      ]),
    ),
  });

  // Identical to the un-epic'd fixture: two extra open epics, one blocked, one
  // closed and one leading the ready queue all counted for nothing.
  assert.deepEqual(entry.counts, {
    open: 3,
    highPriority: 2,
    ready: 2,
    inProgress: 1,
    blocked: 1,
    closedRecent: 1,
  });
  // And they are gone from the lists too, so a board cannot render a row its
  // own count disagrees with. The epic led `bd ready`'s ranking — dropping it
  // must not cost the real work behind it its place.
  assert.deepEqual(entry.ready.map((i) => i.id), ['zz-135', 'zz-4qr']);
  assert.deepEqual(entry.recentlyClosed.map((i) => i.id), ['zz-0pb']);
});

test('the queue reports its shape, not just its size', () => {
  const entry = summarizeBeadsProject(PROJECT, FULL_RESULTS);
  // Four not-closed beads: zz-135 P0, zz-4qr P1, zz-p6y P2, zz-hfl P3. Index
  // IS the priority, so a card can draw the distribution without a legend.
  assert.deepEqual(entry.priorities, [1, 1, 1, 1, 0]);
  // The shape and the scalar can never disagree — same source, same filter.
  assert.equal(entry.priorities[0] + entry.priorities[1], entry.counts.highPriority);
  assert.equal(
    entry.priorities.reduce((a, b) => a + b, 0),
    entry.counts.open + entry.counts.inProgress,
  );
});

test('a priority beyond bd’s scale folds into the last band rather than vanishing', () => {
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    active: ok(
      JSON.stringify([
        { id: 'zz-a', title: 'Way out there', status: 'open', priority: 7, issue_type: 'task' },
      ]),
    ),
  });
  // An unusual priority is still open work somebody has to do.
  assert.deepEqual(entry.priorities, [0, 0, 0, 0, 1]);
});

test('epic containers are absent from the queue shape too', () => {
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    active: ok(
      JSON.stringify([
        ...JSON.parse(BD_ACTIVE),
        { id: 'zz-e1', title: 'Epic', status: 'open', priority: 0, issue_type: 'epic' },
      ]),
    ),
  });
  // A P0 epic must not paint the card's hottest band red.
  assert.deepEqual(entry.priorities, [1, 1, 1, 1, 0]);
});

test('a project the poller could not read reports no shape, not a flat one', () => {
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    ready: { code: 1, stdout: '', stderr: 'Error: no beads project found' },
  });
  assert.equal(entry.ok, false);
  assert.deepEqual(entry.priorities, [0, 0, 0, 0, 0]);
});

test('high priority is P0 and P1 across everything not closed', () => {
  const entry = summarizeBeadsProject(PROJECT, FULL_RESULTS);
  // zz-135 (P0, ready) + zz-4qr (P1, ready). The P2 in flight and the P3
  // blocked chore are not urgent, and nothing closed counts at all.
  assert.equal(entry.counts.highPriority, 2);

  // It cuts ACROSS status rather than partitioning it: promote the in-flight
  // bug and the blocked-open chore and both stored statuses contribute.
  const urgent = JSON.parse(BD_ACTIVE).map((issue) => ({ ...issue, priority: 1 }));
  const promoted = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    active: ok(JSON.stringify(urgent)),
  });
  assert.equal(promoted.counts.highPriority, 4);
  assert.equal(promoted.counts.open, 3);
  assert.equal(promoted.counts.inProgress, 1);
});

const BD_EPICS = JSON.stringify([
  {
    epic: {
      id: 'zz-epc',
      title: 'Make the board honest',
      status: 'open',
      priority: 1,
      issue_type: 'epic',
    },
    total_children: 9,
    closed_children: 4,
    eligible_for_close: false,
  },
]);

const BD_DEFERRED = JSON.stringify([
  {
    id: 'zz-hib',
    title: 'Parked until the archive is deep enough',
    status: 'deferred',
    priority: 2,
    issue_type: 'task',
    parent: 'zz-epc',
    defer_until: '2026-08-29T00:00:00Z',
    updated_at: '2026-08-01T16:31:02Z',
  },
  {
    id: 'zz-hic',
    title: 'Parked with no date',
    status: 'deferred',
    priority: 3,
    issue_type: 'task',
    updated_at: '2026-08-01T16:31:03Z',
  },
]);

test('epic structure groups the live children and keeps bd’s all-time progress', () => {
  // Every active bead in the fixture hangs off the one epic.
  const parented = JSON.parse(BD_ACTIVE).map((issue) => ({ ...issue, parent: 'zz-epc' }));
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    active: ok(JSON.stringify(parented)),
    epics: ok(BD_EPICS),
    deferred: ok(BD_DEFERRED),
  });

  assert.equal(entry.epics.length, 1);
  const epic = entry.epics[0];
  assert.equal(epic.id, 'zz-epc');
  assert.equal(epic.priority, 1);
  // total/closed come from `bd epic status`, NOT from the trailing-week closed
  // list — an epic finished last month would otherwise read as 0% done.
  assert.equal(epic.total, 9);
  assert.equal(epic.closed, 4);
  // Live children by status, so the card cannot disagree with the rows under it.
  assert.deepEqual(epic.counts, { open: 3, inProgress: 1, blocked: 0, deferred: 1 });
  // Parked children are excluded from the shape exactly as they are from every
  // other count: P0 zz-135, P1 zz-4qr, P2 zz-p6y, P3 zz-hfl.
  assert.deepEqual(epic.priorities, [1, 1, 1, 1, 0]);
});

test('a bead with no epic is remainder, not a hidden row', () => {
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    epics: ok(BD_EPICS),
  });
  // Nothing in the base fixture is parented, so the epic keeps its all-time
  // progress but claims no live children.
  assert.deepEqual(entry.epics[0].counts, { open: 0, inProgress: 0, blocked: 0, deferred: 0 });
  assert.equal(entry.ready.every((issue) => issue.parent === null), true);
});

test('an epic nobody has used yet is not a card', () => {
  const empty = JSON.stringify([
    { epic: { id: 'zz-nil', title: 'Never started', status: 'open', priority: 2 }, total_children: 0, closed_children: 0 },
  ]);
  const entry = summarizeBeadsProject(PROJECT, { ...FULL_RESULTS, epics: ok(empty) });
  assert.deepEqual(entry.epics, []);
});

test('parked work is collected, dated, and counted as none of the queue', () => {
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    epics: ok(BD_EPICS),
    deferred: ok(BD_DEFERRED),
  });

  assert.equal(entry.counts.deferred, 2);
  // Soonest wake-up first; a deferral with no date sorts last rather than
  // vanishing, because it is still parked.
  assert.deepEqual(entry.deferred.map((i) => i.id), ['zz-hib', 'zz-hic']);
  assert.equal(entry.deferred[0].deferUntil, '2026-08-29T00:00:00.000Z');
  assert.equal(entry.deferred[1].deferUntil, null);

  // Parked is NOT queued: it enters none of the counts that say how much is
  // left, and none of the queue's shape.
  const base = summarizeBeadsProject(PROJECT, FULL_RESULTS);
  assert.equal(entry.counts.open, base.counts.open);
  assert.equal(entry.counts.ready, base.counts.ready);
  assert.equal(entry.counts.highPriority, base.counts.highPriority);
  assert.deepEqual(entry.priorities, base.priorities);
});

// The skew rule applied to SHAPE rather than to a count: a bd too old for
// `bd epic status` must give a flat board, not a dark one.
test('a bd that cannot answer the optional reads still files a snapshot', () => {
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    epics: { code: 1, stdout: '', stderr: 'unknown command "epic"' },
    deferred: { code: 1, stdout: '', stderr: 'unknown flag' },
  });

  assert.equal(entry.ok, true);
  assert.equal(entry.error, null);
  // Absent, never invented and never zeroed: "0 parked" would be a measurement
  // nobody took.
  assert.equal(entry.epics, undefined);
  assert.equal(entry.deferred, undefined);
  assert.equal('deferred' in entry.counts, false);
  // The work itself is untouched.
  assert.equal(entry.counts.open, 3);
});

test('unparseable optional output degrades the same way', () => {
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    epics: ok('<html>nope</html>'),
  });
  assert.equal(entry.ok, true);
  assert.equal(entry.epics, undefined);
});

const BD_HUMAN = JSON.stringify([
  // This one is also in BD_READY: the label says WHO, ready says NOW.
  { id: 'zz-4qr', title: 'Decide the Korea trip', status: 'open', priority: 1, issue_type: 'task', updated_at: '2026-08-01T10:00:00Z', labels: ['human'] },
  // Every tempting false positive the live hub exposed.
  { id: 'zz-h2', title: 'Export the Bing report later', status: 'deferred', priority: 3, issue_type: 'task', defer_until: '2026-09-01T00:00:00Z', updated_at: '2026-07-20T10:00:00Z', labels: ['human'] },
  { id: 'zz-hfl', title: 'Human ask behind another bead', status: 'open', priority: 3, issue_type: 'task', updated_at: '2026-07-20T10:00:00Z', labels: ['human'] },
  { id: 'zz-h4', title: 'Agent is already doing this', status: 'in_progress', priority: 1, issue_type: 'task', assignee: 'claude-areas', updated_at: '2026-08-01T10:00:00Z', labels: ['human'] },
  { id: 'zz-h3', title: 'Already answered', status: 'closed', priority: 1, issue_type: 'task', updated_at: '2026-08-01T10:00:00Z', labels: ['human'] },
]);

const BD_GATES = JSON.stringify([
  { id: 'zz-g1', title: 'Gate: human', status: 'open', priority: 2, issue_type: 'gate', await_type: 'human', updated_at: '2026-08-01T09:00:00Z' },
  { id: 'zz-g2', title: 'Gate: timer', status: 'open', priority: 2, issue_type: 'gate', await_type: 'timer', updated_at: '2026-08-01T09:00:00Z' },
]);

test('the operator inbox is ready human beads plus gates that wait on a person', () => {
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    human: ok(BD_HUMAN),
    gates: ok(BD_GATES),
  });

  // A gate leads — it holds a bead out of `bd ready`, unlike an ask merely
  // sitting in the inbox. Then priority, then longest untouched.
  assert.deepEqual(entry.waiting.map((i) => i.id), ['zz-g1', 'zz-4qr']);
  assert.equal(entry.counts.waiting, 2);
  // The P1 ask is urgent by priority; the P2 gate is urgent because it holds
  // other work. This count is over the full set, not the truncated list.
  assert.equal(entry.waitingUrgent, 2);
  // The label alone proves none of these are actionable now: deferred wakes
  // later, blocked waits on a bead, in-progress is already owned, and closed
  // has already been answered. The timer gate resolves itself too.
  assert.equal(entry.waiting.some((i) => i.id === 'zz-g2'), false);
  assert.equal(entry.waiting.some((i) => i.id === 'zz-h2'), false);
  assert.equal(entry.waiting.some((i) => i.id === 'zz-hfl'), false);
  assert.equal(entry.waiting.some((i) => i.id === 'zz-h4'), false);
  assert.equal(entry.waiting.some((i) => i.id === 'zz-h3'), false);
  // `bd`'s own issue_type says which row is a gate, so nothing extra rides the
  // payload to mark one.
  assert.equal(entry.waiting[0].issueType, 'gate');
});

test('urgent human count is authoritative when the rendered inbox head is truncated', () => {
  const urgent = Array.from({ length: BEADS_WAITING_LIMIT + 5 }, (_, i) => ({
    id: `zz-hu${i}`,
    title: `Urgent operator ask ${i}`,
    status: 'open',
    priority: 1,
    issue_type: 'task',
    labels: ['human'],
  }));
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    ready: ok(JSON.stringify(urgent)),
    human: ok(JSON.stringify(urgent)),
    gates: ok('[]'),
  });

  assert.equal(entry.waiting.length, BEADS_WAITING_LIMIT);
  assert.equal(entry.counts.waiting, BEADS_WAITING_LIMIT + 5);
  assert.equal(entry.waitingUrgent, BEADS_WAITING_LIMIT + 5);
});

// `bd gate create -r` writes the reason into the DESCRIPTION under a generated
// first line — there is no reason field — so the gate's own title is always the
// mechanism ("Gate: human") and never the ask.
test('a gate’s inbox row is its reason, not the word gate', () => {
  const gates = JSON.stringify([
    {
      id: 'zz-g1',
      title: 'Gate: human',
      status: 'open',
      priority: 2,
      issue_type: 'gate',
      await_type: 'human',
      description:
        'Ad-hoc gate blocking zz-hpf\n\nReason: Approve seeding the July annotations. Time-sensitive: the 28-day check lands 2026-08-05.',
    },
  ]);
  const entry = summarizeBeadsProject(PROJECT, { ...FULL_RESULTS, gates: ok(gates) });
  assert.equal(
    entry.waiting[0].title,
    'Approve seeding the July annotations. Time-sensitive: the 28-day check lands 2026-08-05.',
  );
  // The id still resolves in `bd`, and the row is still identifiably a gate.
  assert.equal(entry.waiting[0].id, 'zz-g1');
  assert.equal(entry.waiting[0].issueType, 'gate');
});

test('a gate created without a reason keeps its own label', () => {
  const gates = JSON.stringify([
    {
      id: 'zz-g1',
      title: 'Gate: human',
      status: 'open',
      priority: 2,
      issue_type: 'gate',
      await_type: 'human',
      description: 'Ad-hoc gate blocking zz-hpf',
    },
  ]);
  const entry = summarizeBeadsProject(PROJECT, { ...FULL_RESULTS, gates: ok(gates) });
  // Never invent a label for a gate whose author gave it none.
  assert.equal(entry.waiting[0].title, 'Gate: human');
});

test('a reason is read from bd’s own format and bounded', () => {
  assert.equal(beadsGateReason('Ad-hoc gate blocking x\n\nReason: Decide the thing'), 'Decide the thing');
  // Multi-paragraph reasons keep their tail; only the length caps them.
  assert.match(beadsGateReason('Reason: One.\nTwo.'), /One\.\nTwo\./);
  assert.equal(beadsGateReason('Ad-hoc gate blocking x'), null);
  assert.equal(beadsGateReason('Reason:   '), null);
  assert.equal(beadsGateReason(undefined), null);
  // The route caps a title at 512; a runaway reason must cost the gate its
  // tail, never the whole project its snapshot.
  assert.equal(beadsGateReason(`Reason: ${'x'.repeat(900)}`).length, 400);
  // ONE reader, not a copy: the Tower's live task read titles a gate through
  // this same function, so the snapshot and the live board can never disagree
  // about what a gate asks.
  assert.equal(beadsGateReason, gateReason);
});

test('projecting ready human work into the inbox never changes queue counts', () => {
  const base = summarizeBeadsProject(PROJECT, FULL_RESULTS);
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    human: ok(BD_HUMAN),
    gates: ok(BD_GATES),
  });
  assert.equal(entry.counts.open, base.counts.open);
  assert.equal(entry.counts.ready, base.counts.ready);
  assert.equal(entry.counts.highPriority, base.counts.highPriority);
  assert.deepEqual(entry.priorities, base.priorities);
  // The one human bead is already one of the two ready/open beads. Waiting is
  // a view over that row, never another unit of work to add to it.
  assert.equal(entry.counts.waiting, 2); // one ready human bead + one human gate
});

test('an inbox read the bd cannot answer leaves no zero behind', () => {
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    human: { code: 1, stdout: '', stderr: 'unknown command "human"' },
    gates: { code: 1, stdout: '', stderr: 'unknown command "gate"' },
  });
  assert.equal(entry.ok, true);
  assert.equal(entry.waiting, undefined);
  assert.equal('waiting' in entry.counts, false);
  assert.equal('waitingUrgent' in entry, false);
});

for (const human of ['null', '[]']) {
  for (const gates of ['null', '[]']) {
    test(`successful empty inbox lists human=${human} gates=${gates} license exact zero`, () => {
      const entry = summarizeBeadsProject(PROJECT, {
        ...FULL_RESULTS, human: ok(human), gates: ok(gates),
      });
      assert.equal(entry.ok, true);
      assert.equal(entry.counts.waiting, 0);
      assert.equal(entry.waitingUrgent, 0);
      assert.deepEqual(entry.waiting, []);
      assert.equal(entry.counts.open, 3);
      assert.equal(entry.counts.ready, 2);
    });
  }
}

test('a successful null gate list leaves ready human work exact', () => {
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS, human: ok(BD_HUMAN), gates: ok('null'),
  });
  assert.deepEqual(entry.waiting.map((item) => item.id), ['zz-4qr']);
  assert.equal(entry.counts.waiting, 1);
  assert.equal(entry.waitingUrgent, 1);
});

test('a successful null human list leaves human gates exact', () => {
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS, human: ok('null'), gates: ok(BD_GATES),
  });
  assert.deepEqual(entry.waiting.map((item) => item.id), ['zz-g1']);
  assert.equal(entry.counts.waiting, 1);
  assert.equal(entry.waitingUrgent, 1);
});

for (const failedRead of ['human', 'gates']) {
  for (const [failure, result] of [
    ['failed', { code: 1, stdout: '', stderr: 'temporarily unavailable' }],
    ['failed with null stdout', { code: 1, stdout: 'null', stderr: 'temporarily unavailable' }],
    ['malformed JSON', ok('<html>unavailable</html>')],
    ['non-list JSON', ok('{}')],
    ['missing', undefined],
  ]) {
    test(`${failedRead} ${failure} cannot license an exact empty inbox`, () => {
      const entry = summarizeBeadsProject(PROJECT, {
        ...FULL_RESULTS, human: ok('[]'), gates: ok('[]'), [failedRead]: result,
      });
      assert.equal(entry.ok, true);
      assert.equal(entry.error, null);
      assert.equal('waiting' in entry.counts, false);
      assert.equal('waitingUrgent' in entry, false);
      assert.deepEqual(entry.waiting, []);
      assert.equal(entry.counts.open, 3);
      assert.equal(entry.counts.ready, 2);
    });
    test(`${failedRead} ${failure} stays unknown beside a successful null counterpart`, () => {
      const entry = summarizeBeadsProject(PROJECT, {
        ...FULL_RESULTS, human: ok('null'), gates: ok('null'), [failedRead]: result,
      });
      assert.equal(entry.ok, true);
      assert.equal('waiting' in entry.counts, false);
      assert.equal('waitingUrgent' in entry, false);
      assert.deepEqual(entry.waiting, []);
    });
  }

  test(`${failedRead} failure preserves the other inbox read as known rows`, () => {
    const entry = summarizeBeadsProject(PROJECT, {
      ...FULL_RESULTS, human: ok(BD_HUMAN), gates: ok(BD_GATES),
      [failedRead]: { code: 1, stdout: '', stderr: 'temporarily unavailable' },
    });
    assert.equal(entry.ok, true);
    assert.equal('waiting' in entry.counts, false);
    assert.equal('waitingUrgent' in entry, false);
    assert.deepEqual(entry.waiting.map((item) => item.id), failedRead === 'human' ? ['zz-g1'] : ['zz-4qr']);
  });
}

test('both inbox reads must recover before empty totals are exact again', () => {
  const failure = { code: 1, stdout: '', stderr: 'temporarily unavailable' };
  const complete = { ...FULL_RESULTS, human: ok('[]'), gates: ok('[]') };
  const failed = summarizeBeadsProject(PROJECT, { ...complete, human: failure, gates: failure });
  assert.equal(failed.waiting, undefined);
  assert.equal('waiting' in failed.counts, false);
  const partial = summarizeBeadsProject(PROJECT, { ...complete, gates: failure });
  assert.equal('waiting' in partial.counts, false);
  const recovered = summarizeBeadsProject(PROJECT, complete);
  assert.equal(recovered.counts.waiting, 0);
  assert.equal(recovered.waitingUrgent, 0);
  assert.deepEqual(recovered.waiting, []);
});

test('null inbox responses recover to exact zero only after both commands succeed', () => {
  const failure = { code: 1, stdout: 'null', stderr: 'temporarily unavailable' };
  const failed = summarizeBeadsProject(PROJECT, { ...FULL_RESULTS, human: failure, gates: failure });
  assert.equal(failed.waiting, undefined);
  assert.equal('waiting' in failed.counts, false);
  const partial = summarizeBeadsProject(PROJECT, { ...FULL_RESULTS, human: ok('null'), gates: failure });
  assert.deepEqual(partial.waiting, []);
  assert.equal('waiting' in partial.counts, false);
  const recovered = summarizeBeadsProject(PROJECT, { ...FULL_RESULTS, human: ok('null'), gates: ok('null') });
  assert.equal(recovered.counts.waiting, 0);
  assert.equal(recovered.waitingUrgent, 0);
  assert.deepEqual(recovered.waiting, []);
});

test('lists are truncated but counts stay true', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `zz-${i}`,
    title: `Bead ${i}`,
    status: 'open',
    priority: 2,
    issue_type: 'task',
  }));
  const entry = summarizeBeadsProject(PROJECT, { ...FULL_RESULTS, ready: ok(JSON.stringify(many)) });
  assert.equal(entry.counts.ready, 25);
  assert.equal(entry.ready.length, BEADS_READY_LIMIT);
  assert.equal(entry.ready[0].id, 'zz-0');
});

test('recently closed is ordered by when it closed, newest first', () => {
  const closed = [
    { id: 'zz-a', title: 'a', status: 'closed', priority: 2, issue_type: 'task', closed_at: '2026-07-28T00:00:00Z' },
    { id: 'zz-b', title: 'b', status: 'closed', priority: 2, issue_type: 'task', closed_at: '2026-07-31T00:00:00Z' },
    { id: 'zz-c', title: 'c', status: 'closed', priority: 2, issue_type: 'task', closed_at: '2026-07-29T00:00:00Z' },
    { id: 'zz-d', title: 'd', status: 'closed', priority: 2, issue_type: 'task', closed_at: '2026-07-30T00:00:00Z' },
    { id: 'zz-e', title: 'e', status: 'closed', priority: 2, issue_type: 'task', closed_at: '2026-07-27T00:00:00Z' },
    { id: 'zz-f', title: 'f', status: 'closed', priority: 2, issue_type: 'task', closed_at: '2026-07-26T00:00:00Z' },
  ];
  const entry = summarizeBeadsProject(PROJECT, { ...FULL_RESULTS, closed: ok(JSON.stringify(closed)) });
  assert.equal(entry.counts.closedRecent, 6);
  assert.equal(entry.recentlyClosed.length, BEADS_CLOSED_LIMIT);
  assert.deepEqual(entry.recentlyClosed.map((i) => i.id), ['zz-b', 'zz-d', 'zz-c', 'zz-a', 'zz-e']);
});

test('recently filed work is sent newest first and capped, whatever became of it', () => {
  const bead = (id, createdAt, extra = {}) => ({
    id, title: id, status: 'open', priority: 2, issue_type: 'task', created_at: createdAt, ...extra,
  });
  const active = [
    bead('zz-1', '2026-07-20T00:00:00Z'),
    bead('zz-2', '2026-07-31T09:00:00Z'),
    bead('zz-3', '2026-07-31T08:00:00Z'),
    bead('zz-4', '2026-07-30T00:00:00Z'),
    bead('zz-5', '2026-07-29T00:00:00Z'),
    // An epic is structure and a gate an ask for approval: neither is a task.
    bead('zz-epic', '2026-07-31T11:00:00Z', { issue_type: 'epic' }),
    bead('zz-gate', '2026-07-31T11:30:00Z', { issue_type: 'gate' }),
    // No filing time is no claim to be new.
    bead('zz-none', undefined),
  ];
  const closed = [bead('zz-quick', '2026-07-31T10:00:00Z', { status: 'closed', closed_at: '2026-07-31T10:05:00Z' })];
  const deferred = [bead('zz-later', '2026-07-31T07:00:00Z', { status: 'deferred' })];
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    active: ok(JSON.stringify(active)),
    closed: ok(JSON.stringify(closed)),
    deferred: ok(JSON.stringify(deferred)),
  });
  assert.equal(entry.recentlyCreated.length, BEADS_CREATED_LIMIT);
  assert.deepEqual(entry.recentlyCreated.map((i) => i.id), ['zz-quick', 'zz-2', 'zz-3', 'zz-later', 'zz-4']);
  assert.equal(entry.recentlyCreated[0].createdAt, '2026-07-31T10:00:00.000Z');
  // The same bead from two reads is one entry.
  const twice = summarizeBeadsProject(PROJECT, { ...FULL_RESULTS, active: ok(JSON.stringify([bead('zz-2', '2026-07-31T09:00:00Z')])), closed: ok('[]'), deferred: ok(JSON.stringify([bead('zz-2', '2026-07-31T09:00:00Z')])) });
  assert.deepEqual(twice.recentlyCreated.map((i) => i.id), ['zz-2']);
});

test('a failed bd call fails that project and nothing about it looks like work', () => {
  const entry = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    ready: { code: 1, stdout: '', stderr: 'Error: cannot use -C directory "/x": no beads project found' },
  });
  assert.equal(entry.ok, false);
  assert.match(entry.error, /bd ready exited 1/);
  assert.match(entry.error, /no beads project found/);
  // "we could not look" must never render as "nothing to do".
  assert.deepEqual(entry.counts, { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 });
  assert.deepEqual(entry.ready, []);
  assert.deepEqual(entry.inProgress, []);
  assert.deepEqual(entry.recentlyClosed, []);
  // Nor any structure: an unreadable repo groups nothing and parks nothing.
  assert.deepEqual(entry.epics, []);
  assert.deepEqual(entry.deferred, []);
  assert.deepEqual(entry.waiting, []);
});

test('unparseable bd output is an error, not an empty board', () => {
  const entry = summarizeBeadsProject(PROJECT, { ...FULL_RESULTS, active: ok('<html>nope</html>') });
  assert.equal(entry.ok, false);
  assert.match(entry.error, /bd active returned unparseable JSON/);
});

test('successful empty arrays are measured empty required lists', () => {
  const entry = summarizeBeadsProject(PROJECT, {
    active: ok('[]'), ready: ok('[]'), blocked: ok('[]'), closed: ok('[]'),
    human: ok('null'), gates: ok('null'),
  });
  assert.equal(entry.ok, true);
  assert.equal(entry.error, null);
  assert.deepEqual(entry.counts, {
    open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, waiting: 0,
  });
  assert.deepEqual(entry.ready, []);
  assert.deepEqual(entry.inProgress, []);
  assert.deepEqual(entry.recentlyClosed, []);
  assert.equal(entry.waitingUrgent, 0);
});

for (const key of ['active', 'ready', 'blocked', 'closed']) {
  for (const [shape, stdout] of [
    ['empty object', '{}'],
    ['unsupported envelope', '{"issues":[]}'],
    ['null', 'null'],
    ['string', '"no tasks"'],
    ['number', '0'],
    ['boolean', 'false'],
    ['null row', '[null]'],
    ['primitive row', '["task"]'],
    ['nested array row', '[[]]'],
    ['missing row id', '[{}]'],
    ['blank row id', '[{"id":"  "}]'],
    ['non-string row id', '[{"id":1}]'],
    ['mixed valid and invalid rows', '[{"id":"zz-valid"},{}]'],
  ]) {
    test(`required ${key} ${shape} is an unknown project, never a successful empty list`, () => {
      const entry = summarizeBeadsProject(PROJECT, {
        ...FULL_RESULTS,
        // Successful optional reads must not turn an invalid required read
        // into a reassuring empty inbox or an apparently ready project.
        human: ok('null'), gates: ok('[]'), epics: ok('[]'), deferred: ok('[]'),
        [key]: ok(stdout),
      });
      assert.equal(entry.ok, false);
      assert.equal(entry.error,
        `bd ${key} returned invalid issue list JSON (expected an array of issues with non-empty ids)`);
      assert.deepEqual(entry.ready, []);
      assert.deepEqual(entry.waiting, []);
      assert.equal(entry.waitingUrgent, undefined);
    });
  }

  for (const [failure, result, error] of [
    ['missing result', undefined, new RegExp(`bd ${key} exited \\?`)],
    ['nonzero exit with valid array', { code: 1, stdout: '[]', stderr: 'read unavailable' }, new RegExp(`bd ${key} exited 1`)],
    ['malformed JSON', ok('[{'), new RegExp(`bd ${key} returned unparseable JSON`)],
  ]) {
    test(`required ${key} ${failure} remains unknown despite complete optional reads`, () => {
      const entry = summarizeBeadsProject(PROJECT, {
        ...FULL_RESULTS, human: ok('null'), gates: ok('null'), [key]: result,
      });
      assert.equal(entry.ok, false);
      assert.match(entry.error, error);
      assert.deepEqual(entry.ready, []);
      assert.deepEqual(entry.waiting, []);
      assert.equal(entry.waitingUrgent, undefined);
    });
  }

  test(`required ${key} recovers from an invalid response to its full task counts`, () => {
    const previous = summarizeBeadsProject(PROJECT, FULL_RESULTS);
    const failed = summarizeBeadsProject(PROJECT, { ...FULL_RESULTS, [key]: ok('{}') });
    const recovered = summarizeBeadsProject(PROJECT, FULL_RESULTS);
    assert.equal(previous.ok, true);
    assert.equal(failed.ok, false);
    assert.deepEqual(recovered, previous);
    assert.equal(recovered.counts.ready, 2);
    assert.equal(recovered.counts.open, 3);
    assert.equal(recovered.counts.inProgress, 1);
    assert.equal(recovered.counts.blocked, 1);
    assert.equal(recovered.counts.closedRecent, 1);
  });
}

test('one missing repo does not cost the others their snapshot', async () => {
  const projects = [
    { asset: 'meals.example', prefix: 'mp', repo: '../meals.example' },
    { asset: 'nosh.example', prefix: 'nom', repo: '../nom' },
    { asset: 'fees.example', prefix: 'fin', repo: '../fees.example' },
  ];
  const body = await collectBeadsSnapshot({
    projects,
    nowMs: Date.parse('2026-08-01T09:00:00Z'),
    repoRoot: '/repo',
    run: (argv) => {
      const dir = argv[1];
      if (dir.endsWith('/nom')) {
        return Promise.resolve({ code: 1, stdout: '', stderr: 'Error: no such directory' });
      }
      if (dir.endsWith('/fees.example')) {
        // bd itself never launched — a different failure, same isolation.
        return Promise.reject(new Error('spawn bd ENOENT'));
      }
      return Promise.resolve(FULL_RESULTS[argv.includes('blocked') ? 'blocked' : argv.includes('ready') ? 'ready' : argv.includes('closed') ? 'closed' : 'active']);
    },
  });

  assert.equal(body.capturedAt, '2026-08-01T09:00:00.000Z');
  assert.deepEqual(body.projects.map((p) => p.ok), [true, false, false]);
  assert.equal(body.projects[0].counts.ready, 2);
  assert.match(body.projects[1].error, /no such directory/);
  assert.match(body.projects[2].error, /could not run: spawn bd ENOENT/);
});

test('a malformed ready list fails only its own project in the collected snapshot', async () => {
  const body = await collectBeadsSnapshot({
    projects: [PROJECT, { asset: 'meals.example', prefix: 'mp', repo: '../meals.example' }],
    nowMs: Date.parse('2026-08-01T09:00:00Z'),
    repoRoot: '/repo',
    run: (argv) => {
      if (argv[1].endsWith('/meals.example') && argv.includes('ready')) return Promise.resolve(ok('{}'));
      const key = argv.includes('blocked') ? 'blocked' : argv.includes('ready') ? 'ready' : argv.includes('closed') ? 'closed' : 'active';
      return Promise.resolve(FULL_RESULTS[key]);
    },
  });
  assert.deepEqual(body.projects.map((project) => project.ok), [true, false]);
  assert.equal(body.projects[0].counts.ready, 2);
  assert.deepEqual(body.projects[0].ready.map((issue) => issue.id), ['zz-135', 'zz-4qr']);
  assert.match(body.projects[1].error, /bd ready returned invalid issue list JSON/);
  assert.deepEqual(body.projects[1].ready, []);
});

test('projects are photographed in the order the task map lists them', async () => {
  const projects = [
    { asset: 'a.example', prefix: 'a', repo: '../a' },
    { asset: 'b.example', prefix: 'b', repo: '../b' },
  ];
  const body = await collectBeadsSnapshot({
    projects,
    repoRoot: '/repo',
    run: () => Promise.resolve(ok('[]')),
  });
  // config/beads.json is where the operator changes this order; a busy project
  // must not float to the top just because it is busy.
  assert.deepEqual(body.projects.map((p) => p.asset), ['a.example', 'b.example']);
});

test('the snapshot is filed against the ingest the runner actually started', () => {
  assert.equal(
    beadsSnapshotUrl(CONFIG),
    `http://${CONFIG.ingestHost}:${CONFIG.ingestPort}/api/beads-snapshot`,
  );
});

test('the board is refreshed every minute', () => {
  assert.equal(CONFIG.beadsPollCron, '* * * * *');
});

/** A poll with everything stubbed: no spawn, no socket, no network. */
function pollDeps(overrides = {}) {
  const lines = [];
  const posted = [];
  return {
    lines,
    posted,
    deps: {
      probe: () => Promise.resolve(true),
      readConfig: () => Promise.resolve(JSON.stringify({ spokes: [PROJECT] })),
      readToken: () => Promise.resolve('operator-secret'),
      run: () => Promise.resolve(ok('[]')),
      post: (url, init) => {
        posted.push({ url, init });
        return Promise.resolve({ ok: true, status: 201, text: () => Promise.resolve('') });
      },
      now: () => Date.parse('2026-08-01T09:00:00Z'),
      state: { skipping: null },
      emit: (level, text) => lines.push(`${level} ${text}`),
      stopped: () => false,
      ...overrides,
    },
  };
}

const UP = { running: true, ready: true };

test('a down hub skips the tick with one WARN and never spams', async () => {
  const { lines, posted, deps } = pollDeps({ probe: () => Promise.resolve(false) });
  assert.equal(await runBeadsPoll(UP, deps), null);
  await runBeadsPoll(UP, deps);
  await runBeadsPoll(UP, deps);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^WARN beads snapshot skipped — the beads task hub is unreachable/);
  assert.equal(posted.length, 0);
});

test('a recovered hub says so, then files', async () => {
  let reachable = false;
  const { lines, posted, deps } = pollDeps({ probe: () => Promise.resolve(reachable) });
  await runBeadsPoll(UP, deps);
  reachable = true;
  await runBeadsPoll(UP, deps);
  assert.equal(posted.length, 1);
  assert.match(lines[1], /^INFO beads snapshot resumed \(was skipped: the beads task hub is unreachable\)/);
});

test('the poll waits for ingest rather than posting into a closed port', async () => {
  const { lines, posted, deps } = pollDeps();
  await runBeadsPoll({ running: false, ready: false }, deps);
  assert.equal(posted.length, 0);
  assert.match(lines[0], /ingest is down\/restarting/);
});

test('no operator token means no post, and a line saying why', async () => {
  const { lines, posted, deps } = pollDeps({ readToken: () => Promise.resolve(null) });
  await runBeadsPoll(UP, deps);
  assert.equal(posted.length, 0);
  assert.match(lines[0], /no OPERATOR_TOKEN is configured/);
});

test('the snapshot is posted with the operator bearer and the captured instant', async () => {
  const { posted, deps } = pollDeps({ run: () => Promise.resolve(ok(BD_READY)) });
  await runBeadsPoll(UP, deps);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, beadsSnapshotUrl(CONFIG));
  assert.equal(posted[0].init.method, 'POST');
  assert.equal(posted[0].init.headers.authorization, 'Bearer operator-secret');
  const body = JSON.parse(posted[0].init.body);
  assert.equal(body.capturedAt, '2026-08-01T09:00:00.000Z');
  assert.equal(body.projects.length, 1);
  assert.equal(body.projects[0].asset, 'root-os');
});

test('a non-201 from ingest is an ERROR line, never a thrown tick', async () => {
  const { lines, deps } = pollDeps({
    post: () => Promise.resolve({ ok: false, status: 422, text: () => Promise.resolve('{"error":"validation"}') }),
  });
  await runBeadsPoll(UP, deps);
  assert.match(lines[0], /^ERROR beads snapshot → HTTP 422/);
});

test('an unreachable ingest is an ERROR line, never a thrown tick', async () => {
  const { lines, deps } = pollDeps({ post: () => Promise.reject(new Error('ECONNREFUSED')) });
  await runBeadsPoll(UP, deps);
  assert.match(lines[0], /^ERROR beads snapshot POST failed: ECONNREFUSED/);
});

test('an unreadable project is reported in the filed line, not hidden', async () => {
  const { lines, deps } = pollDeps({
    run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'Error: no beads project found' }),
  });
  await runBeadsPoll(UP, deps);
  assert.match(lines[0], /1 unreadable: root-os \(bd active exited 1/);
});

// ── The panel-review convention ─────────────────────────────────────────────
// The shape both lanes agree on, and the Tower reads. Every assertion here is
// a contract with something outside this file.

/** One review bead as `bd list --json` hands it back. */
const review = (overrides = {}) => ({
  id: 'nom-4q2',
  title: panelReviewTitle('nosh.example', '2026-08-02'),
  status: 'open',
  priority: 2,
  issue_type: 'task',
  labels: [PANEL_REVIEW_LABEL],
  due_at: '2026-08-09T00:00:00Z',
  metadata: { [PANEL_REVIEW_ASSET_KEY]: 'nosh.example', [PANEL_REVIEW_DATE_KEY]: '2026-08-02' },
  ...overrides,
});

test('a review bead names the panel day where an operator can read it', () => {
  assert.equal(panelReviewTitle('nosh.example', '2026-08-02'), 'Triage the 2026-08-02 serp panel for nosh.example');
});

test('the deadline is measured from the panel, not from when we noticed it', () => {
  // A runner that was down for three days and catches up must not hand the
  // reviewer three extra days: the data is the thing that is ageing.
  assert.equal(panelReviewDueDate('2026-08-02'), '2026-08-09');
  assert.equal(PANEL_REVIEW_DUE_DAYS, 7);
  // Month and year boundaries are arithmetic, not string work.
  assert.equal(panelReviewDueDate('2026-12-28'), '2027-01-04');
});

test('a panel day we cannot read is no deadline at all, never a guessed one', () => {
  assert.equal(panelReviewDueDate('02/08/2026'), null);
  assert.equal(panelReviewDueDate('2026-8-2'), null);
  assert.equal(panelReviewDueDate(''), null);
});

test('a review bead is recognized by its metadata', () => {
  assert.equal(panelReviewPanelDate(review()), '2026-08-02');
});

test('a review whose metadata bd did not hand back is still read from its title', () => {
  // bd omits the field entirely for a bead carrying none, and reading a review
  // an older filer wrote beats filing a duplicate beside it.
  assert.equal(panelReviewPanelDate(review({ metadata: undefined })), '2026-08-02');
  assert.equal(panelReviewPanelDate(review({ metadata: {} })), '2026-08-02');
});

test('a bead that is not one of ours is not mistaken for a review', () => {
  assert.equal(panelReviewPanelDate({ id: 'nom-1', title: 'Triage the serp panel' }), null);
  assert.equal(panelReviewPanelDate({ id: 'nom-1', title: 'Triage the 2026-08-02 serp panel for ' }), null);
  assert.equal(panelReviewPanelDate({ id: 'nom-1' }), null);
});

test('a panel already asked about is never asked about twice', () => {
  assert.equal(panelReviewAlreadyFiled([review()], '2026-08-02'), true);
  assert.equal(panelReviewAlreadyFiled([review()], '2026-08-09'), false);
  // Closed counts: re-filing against finished triage is the ask that teaches an
  // operator to ignore the label.
  assert.equal(
    panelReviewAlreadyFiled([review({ status: 'closed', closed_at: '2026-08-04T10:00:00Z' })], '2026-08-02'),
    true,
  );
  assert.equal(panelReviewAlreadyFiled([], '2026-08-02'), false);
});

test('an invalid automated review remains audit history but does not dedupe valid evidence', () => {
  const invalid = review({
    status: 'closed',
    closed_at: '2026-08-04T10:00:00Z',
    labels: [PANEL_REVIEW_LABEL, INVALID_PANEL_REVIEW_LABEL],
  });
  assert.equal(invalidPanelReview(invalid), true);
  assert.equal(
    invalidPanelReview(review({ labels: `${PANEL_REVIEW_LABEL},${INVALID_PANEL_REVIEW_LABEL}` })),
    true,
  );
  assert.equal(panelReviewAlreadyFiled([invalid], '2026-08-02'), false);
  assert.equal(panelReviewEntry([invalid]), null);
});

test('an invalid review cannot hide another valid review in the same spoke', () => {
  const invalid = review({
    id: 'nom-false',
    status: 'closed',
    closed_at: '2026-08-05T10:00:00Z',
    labels: [PANEL_REVIEW_LABEL, INVALID_PANEL_REVIEW_LABEL],
  });
  const valid = review({ id: 'nom-valid' });
  assert.equal(panelReviewAlreadyFiled([invalid, valid], '2026-08-02'), true);
  assert.equal(panelReviewEntry([invalid, valid]).beadId, 'nom-valid');
});

test('a spoke we could not read is not a spoke with nothing filed', () => {
  // The filer never acts on this — it is the "we did not look" answer, and the
  // caller treats it as a reason to write nothing.
  assert.equal(panelReviewAlreadyFiled(null, '2026-08-02'), false);
});

test('the board reports the open review, deadline and all', () => {
  assert.deepEqual(panelReviewEntry([review()]), {
    beadId: 'nom-4q2',
    panelDate: '2026-08-02',
    dueAt: '2026-08-09T00:00:00.000Z',
    status: 'open',
    closedAt: null,
  });
});

test('bd’s richer statuses collapse to the only question the card asks', () => {
  // in_progress, blocked and deferred are all ways of not having triaged it.
  for (const status of ['in_progress', 'blocked', 'deferred']) {
    assert.equal(panelReviewEntry([review({ status })]).status, 'open');
  }
});

test('a finished review still reports, so “done” cannot read as “never had one”', () => {
  assert.deepEqual(
    panelReviewEntry([review({ status: 'closed', closed_at: '2026-08-04T10:00:00Z' })]),
    {
      beadId: 'nom-4q2',
      panelDate: '2026-08-02',
      dueAt: '2026-08-09T00:00:00.000Z',
      status: 'closed',
      closedAt: '2026-08-04T10:00:00.000Z',
    },
  );
});

test('an open review outranks every closed one, however recent', () => {
  const entry = panelReviewEntry([
    review({ id: 'nom-old', title: panelReviewTitle('nosh.example', '2026-07-26'), status: 'closed', closed_at: '2026-08-03T10:00:00Z', metadata: undefined }),
    review(),
  ]);
  assert.equal(entry.beadId, 'nom-4q2');
  assert.equal(entry.status, 'open');
});

test('with nothing open, the newest close is what the card shows', () => {
  const closed = (id, panelDate, closedAt) =>
    review({ id, title: panelReviewTitle('nosh.example', panelDate), status: 'closed', closed_at: closedAt, metadata: undefined });
  const entry = panelReviewEntry([
    closed('nom-a', '2026-07-19', '2026-07-21T10:00:00Z'),
    closed('nom-c', '2026-08-02', '2026-08-04T10:00:00Z'),
    closed('nom-b', '2026-07-26', '2026-07-28T10:00:00Z'),
  ]);
  assert.equal(entry.beadId, 'nom-c');
  assert.equal(entry.panelDate, '2026-08-02');
});

test('a property with no review at all reports none, not nothing', () => {
  // `null` is a measurement: we looked, this property has never been asked.
  assert.equal(panelReviewEntry([]), null);
  // An unreadable list is the OTHER absence, and the poller keys off it.
  assert.equal(panelReviewEntry(undefined), null);
});

test('a stray label-mate is skipped rather than rendered as a review', () => {
  assert.equal(panelReviewEntry([{ id: 'nom-9', title: 'Something else entirely', status: 'open' }]), null);
});

// ── The poller’s side of it ─────────────────────────────────────────────────

const BD_PANEL_REVIEW = JSON.stringify([review()]);

test('the poller asks each spoke what it has triaged', () => {
  const args = panelReviewListArgs('/repos/nom');
  assert.deepEqual(args.slice(0, 2), ['-C', '/repos/nom']);
  assert.ok(args.includes('--label') && args.includes(PANEL_REVIEW_LABEL));
  // Closed included: it is the only thing that separates a property that
  // finished this morning from one that has never had a panel.
  assert.ok(args.includes('open,in_progress,blocked,deferred,closed'));
  assert.ok(args.includes('--json'));
});

test('the filer and the board ask the spoke exactly the same question', () => {
  // Two different questions would let the filer duplicate a review the board
  // then fails to show.
  assert.deepEqual(beadsPollArgs('/repos/nom', '2026-07-25').panelReview, panelReviewListArgs('/repos/nom'));
});

test('triage state rides the snapshot alongside the work', () => {
  const entry = summarizeBeadsProject(PROJECT, { ...FULL_RESULTS, panelReview: ok(BD_PANEL_REVIEW) });
  assert.deepEqual(entry.panelReview, {
    beadId: 'nom-4q2',
    panelDate: '2026-08-02',
    dueAt: '2026-08-09T00:00:00.000Z',
    status: 'open',
    closedAt: null,
  });
});

test('a spoke with no review reports none — a measurement, not a silence', () => {
  const entry = summarizeBeadsProject(PROJECT, { ...FULL_RESULTS, panelReview: ok('[]') });
  assert.equal(entry.panelReview, null);
});

test('a bd that cannot answer about reviews leaves no “nothing to triage” behind', () => {
  const entry = summarizeBeadsProject(PROJECT, FULL_RESULTS);
  assert.equal('panelReview' in entry, false);
  const failed = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    panelReview: { code: 1, stdout: '', stderr: 'unknown flag: --label' },
  });
  assert.equal('panelReview' in failed, false);
});

// ── The Tower handoff join ──────────────────────────────────────────────────
// The read side of the grammar apps/tower/src/lib/task-handoff.ts emits. Every
// assertion here is a contract with that emitter and with the finding card that
// renders the result: rename a metadata key on either side and a marker quietly
// disappears from every finding in the portfolio.

/** One handoff bead as `bd list --json` hands it back, metadata parsed into an
 * object and the key byte-exact including its comma. */
const handoff = (overrides = {}) => ({
  id: 'mp-1w2',
  title: 'Expand pages already earning search demand',
  status: 'open',
  priority: 1,
  issue_type: 'task',
  labels: [HANDOFF_LABEL, 'asset:meals.example', 'rule:item-openers', 'key:item-openers'],
  metadata: {
    noticeos_source: HANDOFF_LABEL,
    [HANDOFF_ASSET_FIELD]: 'meals.example',
    [HANDOFF_KIND_FIELD]: 'finding',
    noticeos_rule: 'item-openers',
    [HANDOFF_KEY_FIELD]: 'item-openers',
  },
  ...overrides,
});

/** The same bead as one filed before the NoticeOS rename carries it: the
 * `reindex-handoff` label and `reindex_*` metadata, exactly as
 * apps/tower/src/lib/task-handoff.ts wrote them then. */
const legacyHandoff = (overrides = {}) => ({
  id: 'mp-0ld',
  title: 'Expand pages already earning search demand',
  status: 'open',
  priority: 1,
  issue_type: 'task',
  labels: ['reindex-handoff', 'asset:meals.example', 'rule:item-openers', 'key:item-openers'],
  metadata: {
    reindex_source: 'reindex-handoff',
    reindex_asset: 'meals.example',
    reindex_kind: 'finding',
    reindex_rule: 'item-openers',
    reindex_key: 'item-openers',
  },
  ...overrides,
});

test('handoffs are written under the NoticeOS names', () => {
  assert.equal(HANDOFF_LABEL, 'noticeos-handoff');
  assert.equal(HANDOFF_KEY_FIELD, 'noticeos_key');
  assert.equal(HANDOFF_KIND_FIELD, 'noticeos_kind');
  assert.equal(HANDOFF_ASSET_FIELD, 'noticeos_asset');
});

test('the poller asks each spoke what has been filed from its handoffs', () => {
  const args = handoffListArgs('/repos/mp');
  assert.deepEqual(args.slice(0, 2), ['-C', '/repos/mp']);
  // Either label: beads filed before the rename wear reindex-handoff.
  assert.equal(args[args.indexOf('--label-any') + 1], 'noticeos-handoff,reindex-handoff');
  assert.equal(args.includes('--label'), false);
  // Closed included: a finding whose work shipped last month and one nobody
  // ever filed both have no OPEN bead, and only the closed one tells them
  // apart — which is the difference between "shipped, not proven" and
  // "untouched".
  assert.ok(args.includes('open,in_progress,blocked,deferred,closed'));
  assert.ok(args.includes('--json'));
});

test('the join is its own read, not a slice of the queue heads', () => {
  // The ready/closed lists are capped at ten and five. A bead filed a month ago
  // is outside all of them, and a join that could only see the head of a queue
  // would answer "never filed" for work that plainly was.
  const args = beadsPollArgs('/repos/mp', '2026-07-25');
  assert.deepEqual(args.handoffs, handoffListArgs('/repos/mp'));
  assert.ok(!args.handoffs.includes('--closed-after'));
  // Unlimited on the way in: picking WHICH bead a refiled finding shows has to
  // happen over all of them, not over whichever page bd returned.
  assert.deepEqual(args.handoffs.slice(-2), ['--limit', '0']);
});

test('a saturated property loses its oldest shipped work, never its open work', () => {
  const closed = (id, closedAt, key) =>
    handoff({
      id,
      status: 'closed',
      closed_at: closedAt,
      metadata: { ...handoff().metadata, [HANDOFF_KEY_FIELD]: key },
    });
  const rows = [];
  // More shipped work than the cap can hold, each closed a day after the last:
  // `shipped-0` is the oldest close in the set.
  const day = 86_400_000;
  const base = Date.parse('2026-01-01T10:00:00Z');
  for (let i = 0; i < HANDOFF_LIMIT + 5; i += 1) {
    rows.push(closed(`mp-c${i}`, new Date(base + i * day).toISOString(), `shipped-${i}`));
  }
  // …plus one thing somebody is still working on.
  rows.push(handoff({ id: 'mp-live' }));

  const entries = handoffEntries(rows, 'meals.example');
  assert.equal(entries.length, HANDOFF_LIMIT);
  assert.ok(entries.some((e) => e.beadId === 'mp-live'));
  // The bead that fell off is the one whose work shipped longest ago — the
  // least useful marker on a page, and a rendering bound rather than a claim
  // that nothing was ever filed for it.
  assert.equal(entries.some((e) => e.key === 'shipped-0'), false);
});

test('a filed bead is joined to the finding by its exact key', () => {
  assert.deepEqual(handoffEntries([handoff()], 'meals.example'), [
    { kind: 'finding', key: 'item-openers', beadId: 'mp-1w2', status: 'open', closedAt: null },
  ]);
});

test('a bead filed before the rename still joins its finding, and still dedupes against a new one', () => {
  // The filed-task badge reads this entry: the old bead renders exactly as it did.
  assert.deepEqual(handoffEntries([legacyHandoff()], 'meals.example'), [
    { kind: 'finding', key: 'item-openers', beadId: 'mp-0ld', status: 'open', closedAt: null },
  ]);
  // Old and new beads for one finding are ONE marker, not two.
  const closedNew = handoff({ status: 'closed', closed_at: '2026-09-01T10:00:00Z' });
  assert.deepEqual(handoffEntries([closedNew, legacyHandoff()], 'meals.example'), [
    { kind: 'finding', key: 'item-openers', beadId: 'mp-0ld', status: 'open', closedAt: null },
  ]);
  // The old bead's asset still guards against a bead filed in the wrong repo.
  assert.deepEqual(handoffEntries([legacyHandoff()], 'nosh.example'), []);
});

test('a panel review, a push ask and a drift report filed before the rename are still recognized', () => {
  assert.equal(panelReviewPanelDate(review({ metadata: { reindex_panel_asset: 'nosh.example', reindex_panel_date: '2026-08-02' } })), '2026-08-02');
  assert.equal(panelReviewAlreadyFiled([review({ metadata: { reindex_panel_asset: 'nosh.example', reindex_panel_date: '2026-08-02' } })], '2026-08-02'), true);
  assert.equal(taskMapBeadAsset({ title: 'something else', metadata: { reindex_task_map_asset: 'nosh.example' } }), 'nosh.example');
  assert.equal(PANEL_REVIEW_DATE_KEY, 'noticeos_panel_date');
  assert.equal(PUSH_STATE_ASSET_KEY, 'noticeos_push_asset');
  assert.equal(TASK_MAP_ASSET_KEY, 'noticeos_task_map_asset');
});

test('a key keeps every byte the searcher typed', () => {
  // `bd` splits LABEL values on commas, which is why the label carries a slug
  // and the join reads metadata. A query key with a comma in it must survive
  // exactly, or it matches no row at all.
  const key = 'best "meal plan", weekly';
  const [entry] = handoffEntries(
    [handoff({ metadata: { ...handoff().metadata, [HANDOFF_KIND_FIELD]: 'query', [HANDOFF_KEY_FIELD]: key } })],
    'meals.example',
  );
  assert.equal(entry.key, key);
  assert.equal(entry.kind, 'query');
});

test('a page handoff joins by its absolute URL while unknown kinds stay dropped', () => {
  const key = 'https://meals.example/recipes/quick';
  const asPage = handoff({
    id: 'mp-page',
    metadata: {
      ...handoff().metadata,
      [HANDOFF_KIND_FIELD]: 'page',
      [HANDOFF_KEY_FIELD]: key,
    },
  });
  const unknown = handoff({
    id: 'mp-unknown',
    metadata: {
      ...handoff().metadata,
      [HANDOFF_KIND_FIELD]: 'dashboard',
      [HANDOFF_KEY_FIELD]: key,
    },
  });

  assert.deepEqual(handoffEntries([unknown, asPage], 'meals.example'), [
    { kind: 'page', key, beadId: 'mp-page', status: 'open', closedAt: null },
  ]);
});

test('bd’s richer statuses collapse to whether the work has landed', () => {
  for (const status of ['open', 'in_progress', 'blocked', 'deferred']) {
    assert.equal(handoffEntries([handoff({ status })], 'meals.example')[0].status, 'open');
  }
  assert.deepEqual(
    handoffEntries([handoff({ status: 'closed', closed_at: '2026-08-02T10:00:00Z' })], 'meals.example'),
    [
      {
        kind: 'finding',
        key: 'item-openers',
        beadId: 'mp-1w2',
        status: 'closed',
        closedAt: '2026-08-02T10:00:00.000Z',
      },
    ],
  );
});

test('a bead filed in the wrong repo never lands on a stranger’s finding', () => {
  // Finding keys are RULE ids, so `item-openers` exists on every property. The
  // handoff text warns about filing from the wrong directory by name; when it
  // happens, the metadata is the only thing that catches it.
  assert.deepEqual(handoffEntries([handoff()], 'nosh.example'), []);
});

test('a bead that predates the asset key is still read from the repo it is in', () => {
  const metadata = { ...handoff().metadata };
  delete metadata[HANDOFF_ASSET_FIELD];
  assert.equal(handoffEntries([handoff({ metadata })], 'meals.example').length, 1);
});

test('a labelled bead nothing can be joined to is dropped, never guessed', () => {
  const cases = [
    handoff({ metadata: undefined }),
    handoff({ metadata: {} }),
    handoff({ metadata: { ...handoff().metadata, [HANDOFF_KEY_FIELD]: '  ' } }),
    handoff({ metadata: { ...handoff().metadata, [HANDOFF_KIND_FIELD]: 'epic' } }),
    handoff({ id: '' }),
  ];
  for (const row of cases) {
    assert.deepEqual(handoffEntries([row], 'meals.example'), []);
  }
});

test('one finding shows one bead: open work wins over shipped work', () => {
  const entries = handoffEntries(
    [
      handoff({ id: 'mp-old', status: 'closed', closed_at: '2026-08-01T10:00:00Z' }),
      handoff({ id: 'mp-now' }),
    ],
    'meals.example',
  );
  assert.deepEqual(entries.map((e) => e.beadId), ['mp-now']);
});

test('among finished attempts the current one is the most recently closed', () => {
  const closed = (id, closedAt) => handoff({ id, status: 'closed', closed_at: closedAt });
  const entries = handoffEntries(
    [closed('mp-first', '2026-07-01T10:00:00Z'), closed('mp-second', '2026-08-01T10:00:00Z')],
    'meals.example',
  );
  assert.deepEqual(entries.map((e) => e.beadId), ['mp-second']);
});

test('a query and a finding sharing a key are two different rows', () => {
  const asQuery = handoff({
    id: 'mp-9zz',
    metadata: { ...handoff().metadata, [HANDOFF_KIND_FIELD]: 'query' },
  });
  const entries = handoffEntries([handoff(), asQuery], 'meals.example');
  assert.deepEqual(
    entries.map((e) => `${e.kind}:${e.beadId}`),
    ['finding:mp-1w2', 'query:mp-9zz'],
  );
});

test('two identical hubs produce two identical snapshots', () => {
  // Sorted, so the payload is a function of the register's state and not of the
  // order `bd` happened to answer in.
  const other = handoff({
    id: 'mp-4kq',
    metadata: { ...handoff().metadata, [HANDOFF_KEY_FIELD]: 'gsc-decline-1' },
  });
  assert.deepEqual(
    handoffEntries([handoff(), other], 'meals.example').map((e) => e.key),
    handoffEntries([other, handoff()], 'meals.example').map((e) => e.key),
  );
});

test('filed work rides the snapshot alongside the queue', () => {
  const entry = summarizeBeadsProject(
    { asset: 'meals.example', prefix: 'mp', repo: '../meals.example' },
    { ...FULL_RESULTS, handoffs: ok(JSON.stringify([handoff()])) },
  );
  assert.deepEqual(entry.handoffs, [
    { kind: 'finding', key: 'item-openers', beadId: 'mp-1w2', status: 'open', closedAt: null },
  ]);
});

test('a spoke with nothing filed reports an empty list — a measurement', () => {
  // This is the ONLY thing that licenses a finding card to present itself as
  // untouched work.
  const entry = summarizeBeadsProject(PROJECT, { ...FULL_RESULTS, handoffs: ok('[]') });
  assert.deepEqual(entry.handoffs, []);
});

test('a bd that cannot answer leaves no “nothing was filed” behind', () => {
  const entry = summarizeBeadsProject(PROJECT, FULL_RESULTS);
  assert.equal('handoffs' in entry, false);
  const failed = summarizeBeadsProject(PROJECT, {
    ...FULL_RESULTS,
    handoffs: { code: 1, stdout: '', stderr: 'unknown flag: --label' },
  });
  assert.equal('handoffs' in failed, false);
});

// ── The filer lane ──────────────────────────────────────────────────────────

test('the filer reads the ingest the runner actually started', () => {
  assert.equal(
    serpPanelLandingsUrl(CONFIG),
    `http://${CONFIG.ingestHost}:${CONFIG.ingestPort}/api/serp-panel-landings`,
  );
});

test('the collection is checked hourly, off the ticks the ingest crons already use', () => {
  assert.match(CONFIG.panelFilerCron, /^\d+ \* \* \* \*$/);
  const minute = Number(CONFIG.panelFilerCron.split(' ')[0]);
  assert.equal(minute % 15 === 0, false);
});

test('a landing is a property and a collection day, and nothing less', () => {
  const landings = parsePanelLandings({
    landings: [
      { asset: 'nosh.example', panelDate: '2026-08-02', landedAt: '2026-08-02T12:47:31Z', status: 'success', panel: true, queries: 6, families: 6 },
      { asset: '', panelDate: '2026-08-02' },
      { asset: 'meals.example', panelDate: 'last monday' },
      { panelDate: '2026-08-02' },
    ],
  });
  assert.deepEqual(landings, [
    { asset: 'nosh.example', panelDate: '2026-08-02', landedAt: '2026-08-02T12:47:31.000Z', panel: true, queries: 6, families: 6, reports: null },
  ]);
});

/**
 * A property with no entry in config/serp-panel.json buys five report families
 * every Monday. The landing carries `panel: false`, and everything the filer
 * decides from it (wording, scope, acceptance) follows that flag alone.
 */
test('a collection with no panel is a landing, sized by families rather than queries', () => {
  const landings = parsePanelLandings({
    landings: [
      { asset: 'areas.example', panelDate: '2026-08-03', landedAt: '2026-08-03T12:45:00Z', status: 'success', panel: false, queries: null, families: 5 },
    ],
  });
  assert.deepEqual(landings, [
    { asset: 'areas.example', panelDate: '2026-08-03', landedAt: '2026-08-03T12:45:00.000Z', panel: false, queries: null, families: 5, reports: null },
  ]);
});

// An older ingest reported panel collections only and always sized them. Read
// that way, its rows still file the wording the portfolio already reads instead
// of silently regrading them.
test('a landing from an ingest that predates the flag is read as a panel', () => {
  const [landing] = parsePanelLandings({
    landings: [{ asset: 'nosh.example', panelDate: '2026-08-02', queries: 6 }],
  });
  assert.equal(landing.panel, true);
  assert.equal(landing.families, null);
});

test('a body that is not a landings list files nothing rather than throwing', () => {
  assert.deepEqual(parsePanelLandings({}), []);
  assert.deepEqual(parsePanelLandings(null), []);
  assert.deepEqual(parsePanelLandings({ landings: 'soon' }), []);
});

test('one property gets one review, whatever the endpoint says', () => {
  const landings = parsePanelLandings({
    landings: [
      { asset: 'nosh.example', panelDate: '2026-08-02' },
      { asset: 'nosh.example', panelDate: '2026-07-26' },
    ],
  });
  assert.equal(landings.length, 1);
  assert.equal(landings[0].panelDate, '2026-08-02');
});

test('the bead carries the whole convention, in the property’s own repo', () => {
  const argv = panelReviewCreateArgs('/repos/nom', { asset: 'nosh.example', panelDate: '2026-08-02', panel: true, queries: 6 });
  assert.deepEqual(argv.slice(0, 2), ['-C', '/repos/nom']);
  assert.deepEqual(argv.slice(2, 4), ['--actor', PANEL_REVIEW_ACTOR]);
  assert.equal(argv[4], 'create');
  assert.equal(argv[5], 'Triage the 2026-08-02 serp panel for nosh.example');
  assert.deepEqual(argv.slice(argv.indexOf('--labels'), argv.indexOf('--labels') + 2), ['--labels', PANEL_REVIEW_LABEL]);
  assert.deepEqual(argv.slice(argv.indexOf('--due'), argv.indexOf('--due') + 2), ['--due', '2026-08-09']);
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--metadata') + 1]), {
    [PANEL_REVIEW_ASSET_KEY]: 'nosh.example',
    [PANEL_REVIEW_DATE_KEY]: '2026-08-02',
  });
  // Stated, not inherited: a bd default that changes upstream must not
  // re-grade a year of review beads.
  assert.deepEqual(argv.slice(argv.indexOf('--type'), argv.indexOf('--type') + 2), ['--type', 'task']);
  assert.deepEqual(argv.slice(argv.indexOf('--priority'), argv.indexOf('--priority') + 2), ['--priority', '2']);
});

/**
 * The identity guarantee: a panel-less property's review differs in WORDING
 * and SCOPE only. The label and the two metadata keys are byte-identical to a
 * panel property's, because those are what the poller and the Tower match on;
 * change them and every review already filed goes unrecognized, which the filer
 * would read as "never filed" and duplicate.
 */
test('a panel-less review is the same bead with a different noun', () => {
  const landing = { asset: 'areas.example', panelDate: '2026-08-03', panel: false, queries: null, families: 5 };
  const argv = panelReviewCreateArgs('/repos/areas', landing);
  assert.equal(argv[5], 'Triage the 2026-08-03 signal collection for areas.example');
  assert.deepEqual(argv.slice(argv.indexOf('--labels'), argv.indexOf('--labels') + 2), ['--labels', PANEL_REVIEW_LABEL]);
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--metadata') + 1]), {
    [PANEL_REVIEW_ASSET_KEY]: 'areas.example',
    [PANEL_REVIEW_DATE_KEY]: '2026-08-03',
  });
  assert.deepEqual(argv.slice(argv.indexOf('--due'), argv.indexOf('--due') + 2), ['--due', '2026-08-10']);
  assert.equal(argv[argv.indexOf('--acceptance') + 1], COLLECTION_REVIEW_ACCEPTANCE);
});

test('the title says panel only when a panel landed', () => {
  assert.equal(panelReviewTitle('nosh.example', '2026-08-02', true), 'Triage the 2026-08-02 serp panel for nosh.example');
  assert.equal(
    panelReviewTitle('areas.example', '2026-08-02', false),
    'Triage the 2026-08-02 signal collection for areas.example',
  );
  // Default is the wording the portfolio already reads.
  assert.equal(panelReviewTitle('nosh.example', '2026-08-02'), 'Triage the 2026-08-02 serp panel for nosh.example');
});

// Both forms dedupe, or the filer double-files against beads whose metadata `bd`
// did not hand back.
test('the title fallback recognizes a review in either wording', () => {
  assert.equal(
    panelReviewPanelDate({ id: 'ac-1', title: 'Triage the 2026-08-03 signal collection for areas.example' }),
    '2026-08-03',
  );
  assert.equal(
    panelReviewPanelDate({ id: 'nom-1', title: 'Triage the 2026-08-03 serp panel for nosh.example' }),
    '2026-08-03',
  );
  assert.equal(
    panelReviewAlreadyFiled(
      [{ id: 'ac-1', title: 'Triage the 2026-08-03 signal collection for areas.example', status: 'open' }],
      '2026-08-03',
    ),
    true,
  );
});

test('the acceptance bar drops the half a panel-less property cannot produce', () => {
  assert.equal(panelReviewAcceptance(true), PANEL_REVIEW_ACCEPTANCE);
  assert.equal(panelReviewAcceptance(false), COLLECTION_REVIEW_ACCEPTANCE);
  assert.doesNotMatch(COLLECTION_REVIEW_ACCEPTANCE, /panel row/);
  assert.match(COLLECTION_REVIEW_ACCEPTANCE, /ranked keywords, backlinks, LLM mentions/);
  assert.match(COLLECTION_REVIEW_ACCEPTANCE, /evidence-to-readback/);
  assert.match(COLLECTION_REVIEW_ACCEPTANCE, /measurement state and last content ship date\/commit/);
});

test('a panel-less review asks for the inventory, never for a panel walk', () => {
  const text = panelReviewDescription({ asset: 'areas.example', panelDate: '2026-08-03', panel: false, queries: null, families: 5 });
  assert.match(text, /5 DataForSEO report families/);
  assert.match(text, /Inventory pass/);
  assert.match(text, /dataforseo-ranked-keywords\.csv/);
  assert.match(text, /gsc-\*, ga4-\*, bing-webmaster-\*/);
  assert.match(text, /freshness\.json FIRST/);
  assert.match(text, /open readback beads for an active measurement window/);
  assert.match(text, /git log/);
  assert.match(text, /measurement state and last ship date\/commit/);
  assert.match(text, /too-recently-changed-to-verdict/);
  assert.match(text, /readback bead/);
  // The panel walk is not in it — there is no panel to walk.
  assert.doesNotMatch(text, /dataforseo-serp-panel\.csv/);
  assert.doesNotMatch(text, /tracked queries/);
  // But earning one is a named outcome: this is the only route a property has to
  // a panel, and a review that never mentions it leaves the roster frozen.
  assert.match(text, /Settings section is a legitimate outcome/);
  // Off the refresh roster is a root-os defect, not a reason to close this.
  assert.match(text, /Panel refresh in the same Settings section/);
  assert.match(text, /refresh roster in .*signal-panels\.json/);
  assert.doesNotMatch(text, /config\/(serp-panel|signal-panels)\.json/);
});

test('a collection of unknown size still asks for the whole collection', () => {
  const text = panelReviewDescription({ asset: 'areas.example', panelDate: '2026-08-03', panel: false, queries: null, families: null });
  assert.match(text, /this week's DataForSEO report families/);
});

test('the bead tells its reader where the panel is, from inside the property repo', () => {
  const landing = { asset: 'nosh.example', panelDate: '2026-08-02', queries: 6 };
  const text = panelReviewDescription(landing, { osCheckout: 'home-os', installation: { root: '/srv/home-os', env: {} } });
  assert.match(text, /all 6 collected result pages/);
  assert.match(text, /docs\/20-signal-panels\.md in home-os/);
  assert.match(text, /\.local\/signal-dumps\/reports\/nosh\.example\//);
  assert.match(text, /dataforseo-serp-panel\.csv/);
  // Every path is qualified: none of these files are the reader's.
  assert.match(text, /NoticeOS: Sites → nosh\.example → Settings → Tracked search terms/);
  assert.match(text, /pnpm config:export in home-os/);
  assert.match(text, /home-os\/installation\/serp-panel\.json/);
  assert.doesNotMatch(text, /config\/serp-panel\.json/);
  assert.match(text, /panel dir in home-os \(\.local\/signal-dumps/);
  const relocated = panelReviewDescription({ ...landing, panel: false }, {
    osCheckout: 'home-os', installation: { root: '/srv/home-os', env: { NOTICEOS_INSTALLATION_DIR: '/srv/settings' } },
  });
  assert.match(relocated, /tracked terms in \/srv\/settings\/serp-panel\.json/);
  assert.match(relocated, /refresh roster in \/srv\/settings\/signal-panels\.json/);
  assert.doesNotMatch(relocated, /home-os\/installation\//);
  // Measurement state belongs to the property repo, and recency is derived at
  // the target surface rather than guessed from repository-wide activity.
  assert.match(text, /THIS property's open readback beads/);
  assert.match(text, /git log/);
  assert.match(text, /measurement state and last ship date\/commit/);
  assert.match(text, /too-recently-changed-to-verdict/);
  assert.match(text, /readback bead/);
  assert.match(text, /scoped to the content source paths/);
});

// The OS checkout a filed bead points its reader at is the home checkout's own
// folder name, never a name written into the runner.
test("a filed bead names the OS checkout by the home folder's own name", () => {
  assert.equal(osCheckoutName('/home/operator/home-os'), 'home-os');
  assert.equal(osCheckoutName('/srv/noticeos'), 'noticeos');
  const landing = { asset: 'shop.example', panelDate: '2026-08-03', queries: 4 };
  const home = runnerPaths(REPO_ROOT, process.env).osCheckout;
  const text = panelReviewDescription(landing);
  assert.equal(text, panelReviewDescription(landing, { osCheckout: home }));
  assert.match(text, new RegExp(`docs/20-signal-panels\\.md in ${home} is the read contract`));
  const panelless = panelReviewDescription({ ...landing, panel: false, queries: null, families: 5 }, { osCheckout: 'noticeos' });
  assert.match(panelless, /current saved terms at NoticeOS: Sites → shop\.example → Settings/);
  assert.match(panelless, /that is a bead in the OS's own tracker/);
  assert.match(panelless, /Filed automatically by the OS runner \(scripts\/os-up\.mjs\)/);
});

test('a panel of unknown size still asks for the whole panel', () => {
  const text = panelReviewDescription({ asset: 'nosh.example', panelDate: '2026-08-02', queries: null });
  assert.match(text, /every result page in the panel/);
});

/**
 * The landing's `queries` is a count of PROVIDER CALLS, one per (tracked term,
 * device), so a 28-term panel reports 56 while config/serp-panel.json hands the
 * reviewer 28 terms. The count sizes the triage session in the operator's head,
 * so it has to be named for what it counts.
 */
test('a two-device panel is sized in result pages, never in tracked queries', () => {
  const text = panelReviewDescription({ asset: 'meals.example', panelDate: '2026-08-03', queries: 56 }, { osCheckout: 'root-os' });
  assert.match(text, /all 56 collected result pages/);
  // 56 is not a count of queries or of terms.
  assert.doesNotMatch(text, /56 tracked queries/);
  assert.doesNotMatch(text, /56 tracked terms/);
  // And the reader is told what the extra rows ARE, so 56 pages against 28
  // configured terms reads as one fact rather than two registers disagreeing.
  assert.match(text, /one per tracked term per device/);
  assert.match(text, /terms themselves are saved under NoticeOS: Sites → meals\.example → Settings/);
});

test('the filer never divides a call count it cannot divide', () => {
  // The device count does not ride on the wire (the manifest has no device
  // column), so a filer that printed "28 tracked terms" would be inventing the
  // denominator. An odd count (a one-device panel, or a partial collection) has
  // to read as truthfully as an even one.
  const odd = panelReviewDescription({ asset: 'nosh.example', panelDate: '2026-08-02', queries: 7 });
  assert.match(odd, /all 7 collected result pages/);
  // No halved count, and no COUNT of terms at all — the bead points at the term
  // list, it never claims to know how long it is.
  assert.doesNotMatch(odd, /3\.5/);
  assert.doesNotMatch(odd, /\d+ tracked terms/);
});

/**
 * The panel day is the ANCHOR, and the scope is the week's whole collection:
 * the ranked-keywords inventory, the link and LLM families, and the property's
 * own GSC/GA4/Bing exports all land weekly and all need a reader.
 */
test('the review asks for the week’s whole collection, not only the panel', () => {
  const text = panelReviewDescription({ asset: 'nosh.example', panelDate: '2026-08-02', queries: 20 });
  assert.match(text, /Inventory pass/);
  for (const family of [
    /ranked-keywords/,
    /backlinks/,
    /LLM-mention/,
    /GSC \/ GA4 \/ Bing/,
  ]) {
    assert.match(text, family);
  }
  // freshness.json first, and the read contract named: a reviewer standing in
  // the property's repo has to be able to tell stale from silent.
  assert.match(text, /freshness\.json FIRST/);
  assert.match(text, /docs\/20-signal-panels\.md/);
  // Nothing to pull: the daily refresh already keeps the dir current, and a
  // review that starts with a provider call is a review that does not happen.
  assert.doesNotMatch(text, /signals:download/);
});

test('“done” covers both halves, or the second half is decoration', () => {
  assert.match(PANEL_REVIEW_ACCEPTANCE, /Every panel row/);
  assert.match(PANEL_REVIEW_ACCEPTANCE, /week's other collections/);
  assert.match(PANEL_REVIEW_ACCEPTANCE, /evidence-to-readback/);
  assert.match(PANEL_REVIEW_ACCEPTANCE, /measurement state and last content ship date\/commit/);
  assert.match(PANEL_REVIEW_ACCEPTANCE, /readback beads updated/);
});

test('the created id is read back for the log, and its absence is not a failure', () => {
  assert.equal(panelReviewCreatedId('{"id":"nom-4q2"}'), 'nom-4q2');
  assert.equal(panelReviewCreatedId('[{"id":"nom-4q2"}]'), 'nom-4q2');
  assert.equal(panelReviewCreatedId('Created issue nom-4q2'), null);
  assert.equal(panelReviewCreatedId(''), null);
});

/** A filer pass with everything stubbed: no spawn, no socket, no network — and
 * so no `bd create` has ever run against a real property tracker. */
function filerDeps(overrides = {}) {
  const lines = [];
  const ran = [];
  const fetched = [];
  return {
    lines,
    ran,
    fetched,
    deps: {
      probe: () => Promise.resolve(true),
      readConfig: () =>
        Promise.resolve(JSON.stringify({ spokes: [{ asset: 'nosh.example', prefix: 'nom', repo: '../nom' }] })),
      readToken: () => Promise.resolve('operator-secret'),
      get: (url, init) => {
        fetched.push({ url, init });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              windowDays: 21,
              landings: [
                { asset: 'nosh.example', panelDate: '2026-08-02', landedAt: '2026-08-02T12:47:31Z', status: 'success', queries: 6 },
              ],
            }),
        });
      },
      run: (argv) => {
        ran.push(argv);
        return Promise.resolve(ok(argv.includes('create') ? '{"id":"nom-4q2"}' : '[]'));
      },
      // Every collection here is already in its property's published panel;
      // runner-panel-review.test.mjs covers the wait.
      readPublished: (asset) =>
        Promise.resolve({ asset, sources: [{ key: 'dataforseo', collected: true, newestReportDate: '2026-08-03' }] }),
      state: { skipping: null, unmapped: new Set() },
      emit: (level, text) => lines.push(`${level} ${text}`),
      stopped: () => false,
      ...overrides,
    },
  };
}

test('a landed panel with no review becomes one bead in the property’s tracker', async () => {
  const { lines, ran, fetched, deps } = filerDeps();
  const result = await runPanelReviewFiler(UP, deps);
  assert.equal(fetched[0].url, serpPanelLandingsUrl(CONFIG));
  assert.equal(fetched[0].init.headers.authorization, 'Bearer operator-secret');
  assert.deepEqual(result.filed, [{ asset: 'nosh.example', panelDate: '2026-08-02', beadId: 'nom-4q2' }]);
  // The read that decided it, then the write it decided on — in that order.
  assert.equal(ran.length, 2);
  assert.equal(ran[0].includes('create'), false);
  assert.equal(ran[1][4], 'create');
  // Bounded by the property's repo, never by the runner's cwd.
  assert.equal(ran[1][1], path.resolve(REPO_ROOT, '../nom'));
  assert.match(lines[0], /^INFO panel review filed — nom-4q2 in \.\.\/nom/);
});

/**
 * End to end: a panel property and a panel-less property (five report families
 * every Monday, no entry in config/serp-panel.json) are one landing each, one
 * bead each, worded for what they actually bought.
 */
test('a property with no panel gets the same obligation, worded for what it bought', async () => {
  const { ran, deps } = filerDeps({
    readConfig: () =>
      Promise.resolve(
        JSON.stringify({
          spokes: [
            { asset: 'nosh.example', prefix: 'nom', repo: '../nom' },
            { asset: 'areas.example', prefix: 'ac', repo: '../areas.example' },
          ],
        }),
      ),
    get: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            landings: [
              { asset: 'nosh.example', panelDate: '2026-08-03', panel: true, queries: 6, families: 6 },
              { asset: 'areas.example', panelDate: '2026-08-03', panel: false, queries: null, families: 5 },
            ],
          }),
      }),
  });
  const result = await runPanelReviewFiler(UP, deps);
  assert.deepEqual(result.filed.map((f) => f.asset), ['nosh.example', 'areas.example']);
  const titles = ran.filter((argv) => argv.includes('create')).map((argv) => argv[5]);
  assert.deepEqual(titles, [
    'Triage the 2026-08-03 serp panel for nosh.example',
    'Triage the 2026-08-03 signal collection for areas.example',
  ]);
  // One identity for both: the label and the metadata pair never depend on the
  // wording, which is what keeps the poller and the Tower able to see them.
  for (const argv of ran.filter((a) => a.includes('create'))) {
    assert.deepEqual(JSON.parse(argv[argv.indexOf('--metadata') + 1])[PANEL_REVIEW_DATE_KEY], '2026-08-03');
    assert.ok(argv.includes(PANEL_REVIEW_LABEL));
  }
});

// The no-op half of the acceptance: nothing bought, nothing landed, nothing
// owed. The endpoint reports what the archive holds, so a property that collects
// nothing is simply absent from it.
test('a property that bought nothing is never asked to read anything', async () => {
  const { ran, deps } = filerDeps({
    get: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ landings: [] }) }),
  });
  const result = await runPanelReviewFiler(UP, deps);
  assert.deepEqual(result, { checked: 0, filed: [] });
  assert.equal(ran.length, 0);
});

test('a panel already reviewed costs a read and nothing else', async () => {
  const ran = [];
  const { lines, deps } = filerDeps({
    run: (argv) => {
      ran.push(argv);
      if (argv.includes('create')) throw new Error('the filer wrote when it should not have');
      return Promise.resolve(ok(JSON.stringify([review()])));
    },
  });
  const result = await runPanelReviewFiler(UP, deps);
  assert.deepEqual(result, { checked: 1, filed: [] });
  assert.equal(ran.length, 1);
  assert.deepEqual(lines, []);
});

test('re-running the filer creates nothing the second time', async () => {
  // The whole idempotence claim, end to end: the spoke's own beads are the
  // record, so a pass that already filed finds its own work next time.
  const spoke = [];
  const { ran, deps } = filerDeps({
    run: (argv) => {
      ran.push(argv);
      if (argv.includes('create')) {
        spoke.push(review());
        return Promise.resolve(ok('{"id":"nom-4q2"}'));
      }
      return Promise.resolve(ok(JSON.stringify(spoke)));
    },
  });
  assert.equal((await runPanelReviewFiler(UP, deps)).filed.length, 1);
  assert.equal((await runPanelReviewFiler(UP, deps)).filed.length, 0);
  assert.equal((await runPanelReviewFiler(UP, deps)).filed.length, 0);
  assert.equal(spoke.length, 1);
});

test('a runner that was asleep when the panel landed files it on the next pass', async () => {
  // Nothing is remembered between passes: the landing is re-derived from the
  // collection record, so a missed hour is caught up rather than lost.
  const { deps } = filerDeps();
  const result = await runPanelReviewFiler(UP, deps);
  assert.equal(result.filed[0].panelDate, '2026-08-02');
});

test('a dedupe read that failed writes nothing at all', async () => {
  const { lines, ran, deps } = filerDeps({
    run: (argv) => {
      ran.push(argv);
      if (argv.includes('create')) throw new Error('the filer wrote blind');
      return Promise.resolve({ code: 1, stdout: '', stderr: 'Error: no beads project found' });
    },
  });
  const result = await runPanelReviewFiler(UP, deps);
  assert.deepEqual(result, { checked: 0, filed: [] });
  assert.match(lines[0], /^ERROR panel review: nosh\.example — bd panel review list exited 1/);
});

test('unparseable bd output is a reason to write nothing, not to write anyway', async () => {
  const { lines, deps } = filerDeps({
    run: (argv) => {
      if (argv.includes('create')) throw new Error('the filer wrote blind');
      return Promise.resolve(ok('<html>nope</html>'));
    },
  });
  const result = await runPanelReviewFiler(UP, deps);
  assert.deepEqual(result, { checked: 0, filed: [] });
  assert.match(lines[0], /unparseable JSON; filing nothing/);
});

test('a bd that never launched fails that property only', async () => {
  const { lines, deps } = filerDeps({
    readConfig: () =>
      Promise.resolve(
        JSON.stringify({
          spokes: [
            { asset: 'nosh.example', prefix: 'nom', repo: '../nom' },
            { asset: 'meals.example', prefix: 'mp', repo: '../meals.example' },
          ],
        }),
      ),
    get: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            landings: [
              { asset: 'nosh.example', panelDate: '2026-08-02' },
              { asset: 'meals.example', panelDate: '2026-08-02' },
            ],
          }),
      }),
    run: (argv) => {
      if (argv[1].endsWith('/nom')) return Promise.reject(new Error('spawn bd ENOENT'));
      return Promise.resolve(ok(argv.includes('create') ? '{"id":"mp-7g1"}' : '[]'));
    },
  });
  const result = await runPanelReviewFiler(UP, deps);
  assert.deepEqual(result.filed.map((f) => f.asset), ['meals.example']);
  assert.match(lines[0], /^ERROR panel review: nosh\.example — bd list could not run: spawn bd ENOENT/);
});

test('a bd create that failed is a line, never a claimed bead', async () => {
  const { lines, deps } = filerDeps({
    run: (argv) =>
      Promise.resolve(
        argv.includes('create')
          ? { code: 1, stdout: '', stderr: 'Error: prefix mismatch' }
          : ok('[]'),
      ),
  });
  const result = await runPanelReviewFiler(UP, deps);
  assert.deepEqual(result.filed, []);
  assert.match(lines[0], /^ERROR panel review: nosh\.example — bd panel review create exited 1/);
});

test('a property with a collection and no tracker is named once, not hourly', async () => {
  const { lines, deps } = filerDeps({
    readConfig: () => Promise.resolve(JSON.stringify({ spokes: [{ asset: 'other.example', prefix: 'ox', repo: '../other' }] })),
  });
  await runPanelReviewFiler(UP, deps);
  await runPanelReviewFiler(UP, deps);
  await runPanelReviewFiler(UP, deps);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /nosh\.example has a 2026-08-02 collection but no spoke in config\/beads\.json/);
});

test('a down hub files nothing and says so once', async () => {
  const { lines, ran, deps } = filerDeps({ probe: () => Promise.resolve(false) });
  assert.equal(await runPanelReviewFiler(UP, deps), null);
  await runPanelReviewFiler(UP, deps);
  assert.equal(ran.length, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^WARN panel review filer skipped — the beads task hub is unreachable/);
});

test('the filer waits for ingest rather than reading a closed port', async () => {
  const { lines, fetched, deps } = filerDeps();
  assert.equal(await runPanelReviewFiler({ running: false, ready: false }, deps), null);
  assert.equal(fetched.length, 0);
  assert.match(lines[0], /ingest is down\/restarting/);
});

test('no operator token means no read and no write', async () => {
  const { lines, fetched, ran, deps } = filerDeps({ readToken: () => Promise.resolve(null) });
  assert.equal(await runPanelReviewFiler(UP, deps), null);
  assert.equal(fetched.length, 0);
  assert.equal(ran.length, 0);
  assert.match(lines[0], /no OPERATOR_TOKEN is configured/);
});

test('an ingest that cannot answer files nothing, and never throws the tick', async () => {
  const { lines, ran, deps } = filerDeps({ get: () => Promise.reject(new Error('ECONNREFUSED')) });
  assert.equal(await runPanelReviewFiler(UP, deps), null);
  assert.equal(ran.length, 0);
  assert.match(lines[0], /panel landings read failed \(ECONNREFUSED\)/);

  const nonOk = filerDeps({ get: () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }) });
  assert.equal(await runPanelReviewFiler(UP, nonOk.deps), null);
  assert.match(nonOk.lines[0], /panel landings read returned HTTP 401/);
});

test('a recovered read says so before it files again', async () => {
  let reachable = false;
  const { lines, deps } = filerDeps({ probe: () => Promise.resolve(reachable) });
  await runPanelReviewFiler(UP, deps);
  reachable = true;
  await runPanelReviewFiler(UP, deps);
  assert.match(lines[1], /^INFO panel review filer resumed \(was skipped: the beads task hub is unreachable\)/);
});

test('a shutting-down runner files nothing', async () => {
  const { ran, fetched, deps } = filerDeps({ stopped: () => true });
  assert.equal(await runPanelReviewFiler(UP, deps), null);
  assert.equal(ran.length, 0);
  assert.equal(fetched.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Panel refresh — the runner's cadence for the flatten half of the signals lane
// (config/signal-panels.json, docs/20-signal-panels.md). A Worker cron cannot do
// this: a Worker cannot write this machine's disk.
// ─────────────────────────────────────────────────────────────────────────────

/** A stand-in for scripts/run-command.mjs: records the command, answers `exitCode`. */
function refreshDeps(overrides = {}) {
  const lines = [];
  const spawned = [];
  const deps = {
    run: async (cmd, args, options) => {
      spawned.push({ cmd, args, options });
      return { code: overrides.exitCode ?? 0, stdout: '', stderr: '', timedOut: false, error: null };
    },
    state: { skipping: null, running: false },
    emit: (level, msg) => lines.push(`${level} ${msg}`),
    stopped: () => false,
    ...overrides.deps,
  };
  return { lines, spawned, deps };
}

test('the panel refresh runs the repo script, not a second wrangler', async () => {
  const { spawned, deps } = refreshDeps();
  const result = await runPanelRefresh(UP, deps);
  assert.equal(result.code, 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, 'pnpm');
  assert.deepEqual(spawned[0].args, ['signals:refresh']);
});

test('the refresh cadence sits after both archive crons', () => {
  // 12:15 UTC archives GA4/GSC/BWT and 12:45 (Mondays) archives DataForSEO;
  // flattening before either lands would panel yesterday's collection.
  assert.equal(CONFIG.panelRefreshCron, '10 13 * * *');
});

test('a refresh with no runtime to read from is skipped, not attempted', async () => {
  const { spawned, lines, deps } = refreshDeps();
  assert.equal(await runPanelRefresh({ running: false, ready: false }, deps), null);
  assert.equal(spawned.length, 0);
  assert.match(lines[0], /panel refresh skipped — ingest is down\/restarting/);
});

// Two children writing one panel dir is how a half-written CSV gets read as
// provider data.
test('a refresh that is still running is not started again', async () => {
  const { spawned, lines, deps } = refreshDeps();
  deps.state.running = true;
  assert.equal(await runPanelRefresh(UP, deps), null);
  assert.equal(spawned.length, 0);
  assert.match(lines[0], /previous pass has not finished/);
});

test('a recovered refresh says so before it runs again', async () => {
  const { lines, deps } = refreshDeps();
  await runPanelRefresh({ running: false, ready: false }, deps);
  await runPanelRefresh(UP, deps);
  assert.match(lines[1], /^INFO panel refresh resumed \(was skipped: ingest is down\/restarting\)/);
});

test('a non-zero exit is an ERROR line, never a thrown tick', async () => {
  const { lines, deps } = refreshDeps({ exitCode: 2 });
  const result = await runPanelRefresh(UP, deps);
  assert.equal(result.code, 2);
  assert.match(lines[0], /^ERROR panel refresh exited 2/);
});

test('a refresh that cannot spawn frees the lane for the next tick', async () => {
  const error = new Error('ENOENT');
  const { lines, deps } = refreshDeps({
    deps: { run: async () => ({ code: 127, stdout: '', stderr: error.message, timedOut: false, error }) },
  });
  const result = await runPanelRefresh(UP, deps);
  assert.equal(result.code, 1);
  assert.equal(deps.state.running, false);
  assert.match(lines[0], /panel refresh could not run: ENOENT/);
});

test('a shutting-down runner refreshes nothing', async () => {
  const { spawned, deps } = refreshDeps({ deps: { stopped: () => true } });
  assert.equal(await runPanelRefresh(UP, deps), null);
  assert.equal(spawned.length, 0);
});

// Push-state filer: the second bead-writing lane, and the only one that closes.
//
// Its bead's referent (the unpushed commits) moves while the bead sits still,
// so every assertion below is about one of the two ways that goes wrong: a bead
// that outlives its work, or a bead filed/closed on a push state nobody read.

test('push state is reconciled hourly, on a tick no other lane uses', () => {
  assert.match(CONFIG.pushStateCron, /^\d+ \* \* \* \*$/);
  const minute = Number(CONFIG.pushStateCron.split(' ')[0]);
  // Not the ingest crons' quarter-hours, and not the panel filer's minute:
  // seven spokes' worth of git and bd subprocesses should not land on a tick
  // that is already doing something.
  assert.equal(minute % 15 === 0, false);
  assert.notEqual(minute, Number(CONFIG.panelFilerCron.split(' ')[0]));
});

test('a commit gets a day before it becomes an inbox item', () => {
  // Not a claim about how long work may sit unpushed — it is the gap between
  // "the operator is mid-session" and "the operator moved on". Filing on the
  // first tick would file against every commit anybody makes.
  assert.equal(CONFIG.pushStaleHours, 24);
});

// ── Reading git ─────────────────────────────────────────────────────────────

test('the count is symmetric, so the bead can say behind as well as ahead', () => {
  const argv = pushStateCountArgs('/repos/nom');
  assert.deepEqual(argv.slice(0, 2), ['-C', '/repos/nom']);
  assert.ok(argv.includes('--left-right') && argv.includes('--count'));
  // `...` and not `..`: the behind count is what tells the operator whether his
  // push is a fast-forward or a conversation.
  assert.ok(argv.includes('origin/main...main'));
});

test('the fetch is the branch, and the log is the diff against it', () => {
  assert.deepEqual(pushStateFetchArgs('/repos/nom'), ['-C', '/repos/nom', 'fetch', 'origin', 'main']);
  assert.ok(pushStateLogArgs('/repos/nom').includes('origin/main..main'));
});

test('behind and ahead are read in that order, as rev-list prints them', () => {
  assert.deepEqual(parseRevListCounts('0\t5\n'), { behind: 0, ahead: 5 });
  assert.deepEqual(parseRevListCounts('3 2'), { behind: 3, ahead: 2 });
});

test('a count we cannot read is null, and null never closes a bead', () => {
  // A spoke with no origin/main — never pushed, or a different default branch —
  // prints nothing useful. Reading that as zero ahead would close every push
  // bead it has.
  for (const stdout of ['', 'fatal: bad revision', '0', '0\t5\n1\t2\n', undefined]) {
    assert.equal(parseRevListCounts(stdout), null);
  }
});

/** ASCII unit separator — what `git log --format` puts between the fields
 * below, and the one byte a commit subject has never contained. */
const US = '\u001f';
const pushLog = (rows) => rows.map(([hash, seconds, subject]) => `${hash}${US}${seconds}${US}${subject}`).join('\n') + '\n';

test('the commit list carries what an operator recognizes: hash and subject', () => {
  const commits = parseUnpushedCommits(
    pushLog([
      ['6e103aa', 1785780479, 'docs: HHP 8/03 Zoom outcome'],
      ['aafd959', 1785768416, 'docs: search and traffic data comes from NoticeOS'],
    ]),
  );
  assert.deepEqual(commits, [
    { hash: '6e103aa', committedAtMs: 1785780479000, subject: 'docs: HHP 8/03 Zoom outcome' },
    {
      hash: 'aafd959',
      committedAtMs: 1785768416000,
      subject: 'docs: search and traffic data comes from NoticeOS',
    },
  ]);
});

test('git speaks seconds and the runner speaks milliseconds, once, at the parse', () => {
  // A mixed-unit age check reads "9 hours old" for something committed in 1971,
  // and files a bead about work from this minute.
  const [commit] = parseUnpushedCommits(pushLog([['abc1234', 1785768416, 'x']]));
  assert.equal(commit.committedAtMs, 1785768416 * 1000);
});

test('a subject keeps every byte, separators included', () => {
  const subject = 'fix: tabs\tpipes | commas, and all';
  const [commit] = parseUnpushedCommits(pushLog([['abc1234', 1785768416, subject]]));
  assert.equal(commit.subject, subject);
});

test('a line with no timestamp is dropped, never dated to 1970', () => {
  // Epoch 0 is 56 years past any staleness threshold: a repaired line would file
  // a bead about commits made a minute ago.
  assert.deepEqual(parseUnpushedCommits(`abc1234${US}${US}no timestamp\n`), []);
  assert.deepEqual(parseUnpushedCommits(`${US}1785768416${US}no hash\n`), []);
  assert.deepEqual(parseUnpushedCommits('fatal: bad revision\n'), []);
  assert.deepEqual(parseUnpushedCommits(''), []);
});

test('the oldest commit is the minimum, not the last line', () => {
  // Rebases and cherry-picks make commit dates non-monotonic, and `git log`
  // orders by graph, not by clock.
  const commits = parseUnpushedCommits(
    pushLog([
      ['aaa1111', 1785700000, 'newest by graph, oldest by clock'],
      ['bbb2222', 1785800000, 'older by graph, newer by clock'],
    ]),
  );
  assert.equal(oldestUnpushedAt(commits), 1785700000000);
});

test('no commits is no age at all, never zero', () => {
  assert.equal(oldestUnpushedAt([]), null);
  assert.equal(oldestUnpushedAt(undefined), null);
  assert.equal(oldestUnpushedAt([{ hash: 'x', subject: 'y' }]), null);
});

// ── Reading the spoke ───────────────────────────────────────────────────────

const pushBead = (overrides = {}) => ({
  id: 'nom-8kd',
  title: pushStateTitle('nosh.example'),
  status: 'open',
  priority: 1,
  issue_type: 'task',
  labels: [PUSH_STATE_LABEL, PUSH_STATE_HUMAN_LABEL],
  metadata: { [PUSH_STATE_ASSET_KEY]: 'nosh.example' },
  ...overrides,
});

test('the spoke is asked what is OPEN, and closed is deliberately not asked for', () => {
  const argv = pushStateListArgs('/repos/nom');
  assert.deepEqual(argv.slice(0, 2), ['-C', '/repos/nom']);
  assert.ok(argv.includes('--label') && argv.includes(PUSH_STATE_LABEL));
  // The opposite of the panel filer's query, for the opposite reason: a panel
  // day is reviewed once ever, while a spoke goes unpushed again every week. A
  // closed push bead is a finished episode, not a claim on the current one.
  assert.ok(argv.includes('open,in_progress,blocked,deferred'));
  assert.equal(argv.includes('open,in_progress,blocked,deferred,closed'), false);
  assert.ok(argv.includes('--json'));
});

test('an unreadable spoke is null and an empty one is a list — only one licenses a write', () => {
  assert.equal(pushStateOpenBeads(null), null);
  assert.equal(pushStateOpenBeads('nope'), null);
  assert.deepEqual(pushStateOpenBeads([]), []);
  assert.deepEqual(pushStateOpenBeads([pushBead()]), [{ beadId: 'nom-8kd', title: pushStateTitle('nosh.example') }]);
});

test('a closed row is never re-closed, whatever the query returned', () => {
  assert.deepEqual(pushStateOpenBeads([pushBead({ status: 'closed' }), pushBead({ id: '' })]), []);
});

// ── The decision ────────────────────────────────────────────────────────────

const FACTS = {
  fetchOk: true,
  ahead: 2,
  oldestUnpushedEpochMs: Date.parse('2026-08-02T06:00:00Z'),
  openPushBeads: [],
  nowEpochMs: Date.parse('2026-08-03T18:00:00Z'),
};

test('a push state we could not read files nothing and closes nothing', () => {
  // launchd's environment may have no SSH agent. An unread remote is the one
  // input that can produce BOTH mistakes: a bead about work that is already
  // live, and a close on work that is still sitting on this Mac.
  assert.deepEqual(pushStateDecision({ ...FACTS, fetchOk: false }).action, 'skip');
  assert.deepEqual(pushStateDecision({ ...FACTS, ahead: null }).action, 'skip');
  assert.deepEqual(pushStateDecision({ ...FACTS, ahead: -1 }).action, 'skip');
  assert.deepEqual(pushStateDecision({ ...FACTS, openPushBeads: null }).action, 'skip');
});

test('nothing ahead and nothing open is the steady state: no action, no line', () => {
  const decision = pushStateDecision({ ...FACTS, ahead: 0 });
  assert.equal(decision.action, 'none');
});

test('nothing ahead with a bead open closes it', () => {
  const beads = [{ beadId: 'nom-8kd', title: pushStateTitle('nosh.example') }];
  const decision = pushStateDecision({ ...FACTS, ahead: 0, openPushBeads: beads });
  assert.equal(decision.action, 'close');
  assert.deepEqual(decision.beads, beads);
});

test('every open push bead on the spoke closes, not just the first', () => {
  const decision = pushStateDecision({
    ...FACTS,
    ahead: 0,
    openPushBeads: [{ beadId: 'nom-1' }, { beadId: 'nom-2' }],
  });
  assert.equal(decision.beads.length, 2);
});

test('commits younger than the threshold are somebody mid-session, not an inbox item', () => {
  const decision = pushStateDecision({
    ...FACTS,
    oldestUnpushedEpochMs: FACTS.nowEpochMs - 6 * 3_600_000,
  });
  assert.equal(decision.action, 'none');
  assert.equal(Math.round(decision.ageHours), 6);
});

test('past the threshold, with nothing open, one bead is filed', () => {
  const decision = pushStateDecision(FACTS);
  assert.equal(decision.action, 'file');
  assert.equal(decision.ageHours > 24, true);
});

test('the threshold is a parameter, and the boundary files', () => {
  const facts = { ...FACTS, oldestUnpushedEpochMs: FACTS.nowEpochMs - 2 * 3_600_000 };
  assert.equal(pushStateDecision(facts, 24).action, 'none');
  assert.equal(pushStateDecision(facts, 2).action, 'file');
  assert.equal(pushStateDecision(facts, 1).action, 'file');
});

test('an open bead is never filed over, however long the commits have sat', () => {
  // Unlike the panel filer's date-keyed dedupe there is no second identity to
  // file under: one spoke, one open push bead, ever. A closed one does NOT
  // block a new filing — push beads recur legitimately, and the query above is
  // what makes that true.
  const decision = pushStateDecision({
    ...FACTS,
    oldestUnpushedEpochMs: Date.parse('2026-01-01T00:00:00Z'),
    openPushBeads: [{ beadId: 'nom-8kd' }],
  });
  assert.equal(decision.action, 'none');
});

test('commits we could not date are not commits we file about', () => {
  assert.equal(pushStateDecision({ ...FACTS, oldestUnpushedEpochMs: null }).action, 'skip');
  assert.equal(pushStateDecision({ ...FACTS, nowEpochMs: NaN }).action, 'skip');
});

// ── The bead ────────────────────────────────────────────────────────────────

test('the title pins no count, because a count is what went stale', () => {
  // "Push the 5 unpushed local commits" is true of a different five commits
  // two days later.
  const title = pushStateTitle('nosh.example');
  assert.equal(title, 'Push the unpushed local commits on nosh.example');
  assert.doesNotMatch(title, /\d/);
});

test('the bead is filed for the operator, in the property’s own repo', () => {
  const argv = pushStateCreateArgs('/repos/nom', {
    asset: 'nosh.example',
    repoDir: '/repos/nom',
    behind: 0,
    ahead: 2,
    commits: [{ hash: 'aafd959', committedAtMs: 1785768416000, subject: 'docs: the thing' }],
    checkedAt: '2026-08-03T18:00:00.000Z',
  });
  assert.deepEqual(argv.slice(0, 2), ['-C', '/repos/nom']);
  assert.deepEqual(argv.slice(2, 4), ['--actor', PUSH_STATE_ACTOR]);
  assert.equal(argv[4], 'create');
  assert.equal(argv[5], pushStateTitle('nosh.example'));
  // `human` is what puts it in `bd human list` — the inbox the only person who
  // can push actually reads. P1 because nothing else in the queue can ship
  // until this does.
  assert.deepEqual(argv.slice(argv.indexOf('--labels'), argv.indexOf('--labels') + 2), [
    '--labels',
    `${PUSH_STATE_LABEL},${PUSH_STATE_HUMAN_LABEL}`,
  ]);
  assert.deepEqual(argv.slice(argv.indexOf('--priority'), argv.indexOf('--priority') + 2), ['--priority', '1']);
  assert.deepEqual(argv.slice(argv.indexOf('--type'), argv.indexOf('--type') + 2), ['--type', 'task']);
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--metadata') + 1]), {
    [PUSH_STATE_ASSET_KEY]: 'nosh.example',
  });
  assert.deepEqual(argv.slice(argv.indexOf('--acceptance'), argv.indexOf('--acceptance') + 2), [
    '--acceptance',
    PUSH_STATE_ACCEPTANCE,
  ]);
});

test('acceptance is something the runner itself can evaluate', () => {
  // An acceptance criterion nothing can check is how a push bead outlives its
  // own referent — and how it ends up closed on a two-day-old belief.
  assert.match(PUSH_STATE_ACCEPTANCE, /rev-list --left-right --count origin\/main\.\.\.main/);
  assert.match(PUSH_STATE_ACCEPTANCE, /0 ahead/);
});

const FILING = {
  asset: 'nosh.example',
  repoDir: '/Users/operator/dev/nom',
  behind: 1,
  ahead: 2,
  checkedAt: '2026-08-03T18:00:00.000Z',
  commits: [
    { hash: '6e103aa', committedAtMs: 1785780479000, subject: 'docs: HHP 8/03 Zoom outcome' },
    { hash: 'aafd959', committedAtMs: 1785768416000, subject: 'docs: search data comes from NoticeOS' },
  ],
};

test('the description is an ask a human can act on without investigating', () => {
  const text = pushStateDescription(FILING);
  // The ready-to-paste action, against the repo the bead is about.
  assert.match(text, /git -C \/Users\/operator\/dev\/nom push origin main/);
  // What is unpushed, by hash and subject, as of a stated instant.
  assert.match(text, /6e103aa {2}docs: HHP 8\/03 Zoom outcome/);
  assert.match(text, /aafd959 {2}docs: search data comes from NoticeOS/);
  assert.match(text, /AS OF 2026-08-03T18:00:00\.000Z — 2 ahead, 1 behind/);
  // A push is a production release, which is the whole reason this is P1.
  assert.match(text, /Workers Builds/);
  // And nobody has to close it, which is the whole reason the lane exists.
  assert.match(text, /CLOSING: nobody has to/);
});

test('the description says its own count is a snapshot, so the title need not carry one', () => {
  assert.match(pushStateDescription(FILING), /This list ages and the title deliberately carries no count/);
});

test('the threshold in the text is the threshold that filed it', () => {
  assert.match(pushStateDescription({ ...FILING, staleHours: 48 }), /more than 48h/);
  assert.match(pushStateDescription(FILING), new RegExp(`more than ${CONFIG.pushStaleHours}h`));
});

test('a spoke far ahead lists a readable head, not a wall', () => {
  const commits = Array.from({ length: PUSH_STATE_COMMIT_LIMIT + 7 }, (_, i) => ({
    hash: `c${String(i).padStart(6, '0')}`,
    committedAtMs: 1785768416000 + i,
    subject: `commit ${i}`,
  }));
  const text = pushStateDescription({ ...FILING, ahead: commits.length, commits });
  assert.match(text, /…and 7 more/);
  assert.equal(text.includes('c000019'), true);
  assert.equal(text.includes('c000020'), false);
});

test('the close carries the evidence, not just the verdict', () => {
  // A push bead closed by a machine has to say what the machine saw and when,
  // or the next reader has no reason to believe the close.
  const reason = pushStateCloseReason({
    asset: 'nosh.example',
    repoDir: '/Users/operator/dev/nom',
    behind: 3,
    checkedAt: '2026-08-03T18:00:00.000Z',
  });
  assert.match(reason, /git -C \/Users\/operator\/dev\/nom fetch origin main/);
  assert.match(reason, /rev-list --left-right --count origin\/main\.\.\.main/);
  assert.match(reason, /0 ahead \(3 behind\) at 2026-08-03T18:00:00\.000Z/);
  // Recurrence is named: the next divergence is a new bead, not a reopening.
  assert.match(reason, /files a fresh bead rather than reopening/);
});

test('the close is attributed to the lane, not to a person', () => {
  const argv = pushStateCloseArgs('/repos/nom', 'nom-8kd', 'because');
  assert.deepEqual(argv, ['-C', '/repos/nom', '--actor', PUSH_STATE_ACTOR, 'close', 'nom-8kd', '-r', 'because']);
  assert.equal(PUSH_STATE_ACTOR, 'os-up-push-filer');
});

test('the created id is read back the same way both filing lanes read it', () => {
  assert.equal(beadsCreatedId('{"id":"nom-8kd"}'), 'nom-8kd');
  assert.equal(beadsCreatedId('[{"id":"nom-8kd"}]'), 'nom-8kd');
  assert.equal(beadsCreatedId('Created issue nom-8kd'), null);
});

// ── Per-spoke logging ───────────────────────────────────────────────────────

test('a spoke says what is wrong once, not once an hour', () => {
  // Seven repos on an hourly tick: without this, one sibling repo the operator
  // archived writes 168 identical lines a week and buries everything else.
  const seen = new Map();
  assert.equal(pushStateSpokeDecision(seen, 'nosh.example', 'fetch'), true);
  assert.equal(pushStateSpokeDecision(seen, 'nosh.example', 'fetch'), false);
  // A different cause is genuinely new information.
  assert.equal(pushStateSpokeDecision(seen, 'nosh.example', 'counts'), true);
  // Recovery is a transition too, and it is the line that says the lane is
  // trustworthy again.
  assert.equal(pushStateSpokeDecision(seen, 'nosh.example', null), true);
  assert.equal(pushStateSpokeDecision(seen, 'nosh.example', null), false);
  // One spoke's outage never silences another's.
  assert.equal(pushStateSpokeDecision(seen, 'fees.example', 'fetch'), true);
});

// ── The lane ────────────────────────────────────────────────────────────────

const PUSH_NOW = Date.parse('2026-08-03T18:00:00Z');
const PUSH_STALE_SEC = Math.floor((PUSH_NOW - 30 * 3_600_000) / 1000);
const PUSH_FRESH_SEC = Math.floor((PUSH_NOW - 2 * 3_600_000) / 1000);

/** A push-state pass with everything stubbed: no git, no bd, no hub — and so no
 * bead has ever been filed against, or closed in, a real property tracker. */
function pushDeps(overrides = {}) {
  const lines = [];
  const ran = [];
  const gitRan = [];
  const {
    fetchResult = ok(''),
    countsResult = ok('0\t2\n'),
    logResult = ok(
      pushLog([
        ['6e103aa', PUSH_FRESH_SEC, 'docs: HHP 8/03 Zoom outcome'],
        ['aafd959', PUSH_STALE_SEC, 'docs: search and traffic data comes from NoticeOS'],
      ]),
    ),
    listResult = ok('[]'),
    createResult = ok('{"id":"nom-9zz"}'),
    closeResult = ok(''),
    gateResult = ok(''),
    deps = {},
  } = overrides;
  return {
    lines,
    ran,
    gitRan,
    deps: {
      probe: () => Promise.resolve(true),
      readConfig: () =>
        Promise.resolve(JSON.stringify({ spokes: [{ asset: 'nosh.example', prefix: 'nom', repo: '../nom' }] })),
      exists: () => true,
      git: (argv) => {
        gitRan.push(argv);
        if (argv.includes('fetch')) return Promise.resolve(fetchResult);
        if (argv.includes('rev-list')) return Promise.resolve(countsResult);
        return Promise.resolve(logResult);
      },
      run: (argv) => {
        ran.push(argv);
        if (argv.includes('gate')) return Promise.resolve(gateResult);
        if (argv.includes('create')) return Promise.resolve(createResult);
        if (argv.includes('close')) return Promise.resolve(closeResult);
        return Promise.resolve(listResult);
      },
      now: () => PUSH_NOW,
      staleHours: 24,
      state: { skipping: null, degraded: new Map(), gates: new Map() },
      emit: (level, text) => lines.push(`${level} ${text}`),
      stopped: () => false,
      repoRoot: REPO_ROOT,
      ...deps,
    },
  };
}

test('commits left unpushed past the threshold become one bead in that spoke', async () => {
  const { lines, ran, gitRan, deps } = pushDeps();
  const result = await runPushStateFiler(deps);
  assert.deepEqual(result.filed, [{ asset: 'nosh.example', beadId: 'nom-9zz', ahead: 2 }]);
  // Fetch, then count, then read the commits — every answer from this pass.
  assert.deepEqual(gitRan.map((argv) => argv[2]), ['fetch', 'rev-list', 'log']);
  // Bounded by the property's repo, never by the runner's cwd.
  assert.equal(gitRan[0][1], path.resolve(REPO_ROOT, '../nom'));
  // Gates, then the read that decided it, then the write it decided on.
  assert.deepEqual(ran.map((argv) => argv.find((a) => ['gate', 'list', 'create'].includes(a))), [
    'gate',
    'list',
    'create',
  ]);
  assert.match(lines[0], /^INFO push state filed — nom-9zz in \.\.\/nom: "Push the unpushed local commits on nosh\.example" \(2 commit\(s\), oldest 30h old\)/);
});

test('the lane ages a spoke by its oldest commit, not by its newest', async () => {
  // `git log` lists newest first, and the stub's newest commit is two hours
  // old. Reading the head would file nothing here — and a spoke could sit
  // unpushed forever as long as somebody kept committing to it.
  const { lines, deps } = pushDeps();
  const result = await runPushStateFiler(deps);
  assert.equal(result.filed.length, 1);
  assert.match(lines[0], /oldest 30h old/);
});

test('re-running the lane files nothing the second time', async () => {
  // The spoke's own beads are the record: no cursor, no state file, and a pass
  // that already filed finds its own work next time.
  const spoke = [];
  const { ran, deps } = pushDeps({
    deps: {
      run: (argv) => {
        ran.push(argv);
        if (argv.includes('gate')) return Promise.resolve(ok(''));
        if (argv.includes('create')) {
          spoke.push(pushBead());
          return Promise.resolve(ok('{"id":"nom-8kd"}'));
        }
        return Promise.resolve(ok(JSON.stringify(spoke)));
      },
    },
  });
  assert.equal((await runPushStateFiler(deps)).filed.length, 1);
  assert.equal((await runPushStateFiler(deps)).filed.length, 0);
  assert.equal((await runPushStateFiler(deps)).filed.length, 0);
  assert.equal(spoke.length, 1);
});

test('fresh commits are nobody’s inbox item', async () => {
  const { lines, ran, deps } = pushDeps({
    logResult: ok(pushLog([['6e103aa', PUSH_FRESH_SEC, 'docs: written an hour ago']])),
    countsResult: ok('0\t1\n'),
  });
  const result = await runPushStateFiler(deps);
  assert.deepEqual(result.filed, []);
  assert.equal(ran.some((argv) => argv.includes('create')), false);
  assert.deepEqual(lines, []);
});

test('the push lands and the bead closes itself, with the evidence in the reason', async () => {
  const { lines, ran, deps } = pushDeps({
    countsResult: ok('0\t0\n'),
    listResult: ok(JSON.stringify([pushBead()])),
  });
  const result = await runPushStateFiler(deps);
  assert.deepEqual(result.closed, [{ asset: 'nosh.example', beadId: 'nom-8kd' }]);
  const closeArgv = ran.find((argv) => argv.includes('close'));
  assert.equal(closeArgv[5], 'nom-8kd');
  assert.match(closeArgv[7], /reports 0 ahead \(0 behind\) at 2026-08-03T18:00:00\.000Z/);
  assert.match(lines[0], /^INFO push state closed — nom-8kd in \.\.\/nom/);
  // Nothing was ahead, so nothing needed reading beyond the count.
  assert.equal(ran.some((argv) => argv.includes('create')), false);
});

test('a spoke in sync with nothing open is completely silent', async () => {
  const { lines, ran, deps } = pushDeps({ countsResult: ok('0\t0\n') });
  const result = await runPushStateFiler(deps);
  assert.deepEqual(result, { checked: 1, filed: [], closed: [], failed: [] });
  assert.deepEqual(lines, []);
  // The list is still read — it is the only thing that could say a bead is open.
  assert.equal(ran.some((argv) => argv.includes('create') || argv.includes('close')), false);
});

test('a fetch that failed files nothing, closes nothing, and says so once', async () => {
  // launchd's environment may have no SSH agent. Unknown push state is the one
  // input that can produce both mistakes at once.
  const { lines, ran, deps } = pushDeps({
    fetchResult: { code: 128, stdout: '', stderr: 'fatal: could not read Username for https://github.com' },
  });
  const result = await runPushStateFiler(deps);
  // Unread, and the run record says so every pass while the log says it once.
  assert.deepEqual(result, { checked: 0, filed: [], closed: [], failed: [{ asset: 'nosh.example', reason: 'remote-sign-in-refused' }] });
  assert.equal(ran.some((argv) => argv.includes('create') || argv.includes('close')), false);
  assert.deepEqual((await runPushStateFiler(deps)).failed, result.failed);
  await runPushStateFiler(deps);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^WARN push state: nosh\.example — `git fetch origin main` failed \(fatal: could not read Username/);
  assert.match(lines[0], /push state is UNKNOWN/);
});

test('a spoke that starts fetching again says so, once', async () => {
  let broken = true;
  const { lines, deps } = pushDeps({
    countsResult: ok('0\t0\n'),
    deps: {
      git: (argv) => {
        if (argv.includes('fetch')) {
          return Promise.resolve(broken ? { code: 128, stdout: '', stderr: 'Permission denied (publickey)' } : ok(''));
        }
        return Promise.resolve(ok('0\t0\n'));
      },
    },
  });
  await runPushStateFiler(deps);
  broken = false;
  await runPushStateFiler(deps);
  await runPushStateFiler(deps);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^INFO push state: nosh\.example — readable again/);
});

test('a spoke with no origin/main is unreadable, not up to date', async () => {
  // Reading a failed count as zero ahead would close every push bead it has.
  const { lines, ran, deps } = pushDeps({
    countsResult: { code: 128, stdout: '', stderr: "fatal: ambiguous argument 'origin/main...main'" },
    listResult: ok(JSON.stringify([pushBead()])),
  });
  const result = await runPushStateFiler(deps);
  assert.equal(ran.some((argv) => argv.includes('close')), false);
  assert.match(lines[0], /^WARN push state: nosh\.example — could not count origin\/main\.\.\.main/);
  assert.deepEqual(result.failed, [{ asset: 'nosh.example', reason: 'git-read-failed' }]);
});

// Under launchd a fetch can be refused (no SSH agent, no key) and the push
// state goes unread. The run record names each such spoke and a reason code,
// never git's own text, and the recorded step fails, so System health and the
// job's run page show it.
test('an unread push state is named per spoke in the run record, by reason', async () => {
  assert.equal(pushStateUnreadReason('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'), 'remote-sign-in-refused');
  assert.equal(pushStateUnreadReason('fatal: could not read Username for https://github.com: terminal prompts disabled'), 'remote-sign-in-refused');
  assert.equal(pushStateUnreadReason('ssh: Could not resolve hostname github.com: nodename nor servname provided'), 'remote-unreachable');
  assert.equal(pushStateUnreadReason('ssh: connect to host github.com port 22: Operation timed out'), 'remote-unreachable');
  assert.equal(pushStateUnreadReason("fatal: couldn't find remote ref main"), 'git-read-failed');
  assert.equal(pushStateUnreadReason(undefined), 'git-read-failed');

  const { deps } = pushDeps({
    deps: {
      readConfig: () => Promise.resolve(JSON.stringify({ spokes: [
        { asset: 'nosh.example', prefix: 'nom', repo: '../nom' },
        { asset: 'fees.example', prefix: 'fee', repo: '../fees' },
        { asset: 'meals.example', prefix: 'mp', repo: '../meals' },
      ] })),
      git: (argv) => {
        if (argv.includes('fetch') && argv[1].endsWith('nom')) return Promise.resolve({ code: 128, stdout: '', stderr: 'git@github.com: Permission denied (publickey).' });
        if (argv.includes('fetch') && argv[1].endsWith('fees')) return Promise.resolve({ code: 128, stdout: '', stderr: 'ssh: Could not resolve hostname github.com' });
        if (argv.includes('fetch')) return Promise.resolve(ok(''));
        return Promise.resolve(ok('0\t0\n'));
      },
    },
  });
  const result = await runPushStateFiler(deps);
  assert.equal(result.checked, 1);
  assert.deepEqual(result.failed, [
    { asset: 'nosh.example', reason: 'remote-sign-in-refused' },
    { asset: 'fees.example', reason: 'remote-unreachable' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /github\.com|publickey/u, 'git’s own text stays in the log');

  // As the managed service records it: the step fails, and its output names
  // each unread spoke with its reason in words.
  const verdict = stepResult(result);
  assert.equal(verdict.state, 'failed');
  const output = captureWorkflowOutput(result);
  assert.deepEqual(output.items.map((item) => [item.label, item.state, item.fields.find((field) => field.key === 'reason')?.value]), [
    ['nosh.example', 'failed', 'Remote sign-in refused'],
    ['fees.example', 'failed', 'Remote unreachable'],
  ]);
  assert.equal(isWorkflowStepOutput(output), true, 'the Tower’s history reader keeps it');
});

test('a repo that is not on this machine is skipped, and named once', async () => {
  // The task map is portfolio-wide; a clone is per-machine. Normal state, not a
  // fault — and not a reason to touch that spoke's beads.
  const { lines, ran, gitRan, deps } = pushDeps({ deps: { exists: () => false } });
  const result = await runPushStateFiler(deps);
  // Not a failure either: the run record lists no unread spoke for it.
  assert.deepEqual(result, { checked: 0, filed: [], closed: [], failed: [] });
  assert.equal(gitRan.length, 0);
  assert.equal(ran.length, 0);
  await runPushStateFiler(deps);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^WARN push state: nosh\.example — no repo at .*\/nom; skipped/);
});

test('a dedupe read that failed writes nothing at all', async () => {
  const { lines, ran, deps } = pushDeps({
    listResult: { code: 1, stdout: '', stderr: 'Error: no beads project found' },
  });
  const result = await runPushStateFiler(deps);
  assert.deepEqual(result.filed, []);
  assert.equal(ran.some((argv) => argv.includes('create')), false);
  assert.match(lines[0], /^WARN push state: nosh\.example — bd push state list exited 1/);
});

test('unparseable bd output is a reason to write nothing, not to write anyway', async () => {
  const { lines, ran, deps } = pushDeps({ listResult: ok('<html>nope</html>') });
  await runPushStateFiler(deps);
  assert.equal(ran.some((argv) => argv.includes('create')), false);
  assert.match(lines[0], /^WARN push state: nosh\.example — bd push state list/);
});

test('a bd create that failed is a line, never a claimed bead', async () => {
  const { lines, deps } = pushDeps({ createResult: { code: 1, stdout: '', stderr: 'Error: prefix mismatch' } });
  const result = await runPushStateFiler(deps);
  assert.deepEqual(result.filed, []);
  assert.match(lines[0], /^ERROR push state: nosh\.example — bd push state create exited 1/);
});

test('a bd close that failed leaves the bead open rather than reporting it shut', async () => {
  const { lines, deps } = pushDeps({
    countsResult: ok('0\t0\n'),
    listResult: ok(JSON.stringify([pushBead()])),
    closeResult: { code: 1, stdout: '', stderr: 'Error: gate unsatisfied' },
  });
  const result = await runPushStateFiler(deps);
  assert.deepEqual(result.closed, []);
  assert.match(lines[0], /^ERROR push state: nosh\.example — bd push state close exited 1/);
});

test('one broken spoke never costs the others their pass', async () => {
  const { lines, deps } = pushDeps({
    deps: {
      readConfig: () =>
        Promise.resolve(
          JSON.stringify({
            spokes: [
              { asset: 'nosh.example', prefix: 'nom', repo: '../nom' },
              { asset: 'meals.example', prefix: 'mp', repo: '../meals.example' },
            ],
          }),
        ),
      git: (argv) => {
        if (argv[1].endsWith('/nom')) return Promise.reject(new Error('spawn git ENOENT'));
        if (argv.includes('fetch')) return Promise.resolve(ok(''));
        if (argv.includes('rev-list')) return Promise.resolve(ok('0\t2\n'));
        return Promise.resolve(
          ok(pushLog([['aafd959', PUSH_STALE_SEC, 'docs: search and traffic data comes from NoticeOS']])),
        );
      },
    },
  });
  const result = await runPushStateFiler(deps);
  assert.deepEqual(result.filed.map((f) => f.asset), ['meals.example']);
  assert.match(lines[0], /^WARN push state: nosh\.example — `git fetch origin main` failed \(git could not run: spawn git ENOENT/);
});

// ── Gates ───────────────────────────────────────────────────────────────────

test('every spoke’s gates are evaluated on the same tick', () => {
  assert.deepEqual(beadsGateCheckArgs('/repos/nom'), ['-C', '/repos/nom', 'gate', 'check']);
});

test('gate evaluation happens even for a spoke whose push state is unreadable', async () => {
  // A timer gate's whole promise is that it expires on its own. It does not
  // depend on git, so a missing SSH agent must not stop it.
  const { ran, deps } = pushDeps({ fetchResult: { code: 128, stdout: '', stderr: 'Permission denied (publickey)' } });
  await runPushStateFiler(deps);
  assert.deepEqual(ran.map((argv) => argv.slice(2)), [['gate', 'check']]);
});

test('gates that cannot be evaluated are one warning, not one an hour', async () => {
  const { lines, deps } = pushDeps({
    countsResult: ok('0\t0\n'),
    gateResult: { code: 1, stdout: '', stderr: 'Error: dial tcp 127.0.0.1:3308: connect: connection refused' },
  });
  await runPushStateFiler(deps);
  await runPushStateFiler(deps);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^WARN push state: nosh\.example — bd gate check exited 1/);
  assert.match(lines[0], /timer gates in this spoke will not resolve themselves/);
});

test('a gate failure does not mark the push state degraded', async () => {
  // Separate state keys: a spoke whose gates cannot be evaluated still has a
  // perfectly readable push state, and conflating them silences whichever line
  // arrived second.
  const { lines, deps } = pushDeps({
    countsResult: ok('0\t0\n'),
    listResult: ok(JSON.stringify([pushBead()])),
    gateResult: { code: 1, stdout: '', stderr: 'hub down' },
  });
  const result = await runPushStateFiler(deps);
  assert.equal(result.closed.length, 1);
  assert.equal(lines.filter((line) => line.startsWith('INFO push state closed')).length, 1);
});

// ── Lane-level refusals ─────────────────────────────────────────────────────

test('a down hub touches no spoke and says so once', async () => {
  const { lines, ran, gitRan, deps } = pushDeps({ deps: { probe: () => Promise.resolve(false) } });
  assert.equal(await runPushStateFiler(deps), null);
  await runPushStateFiler(deps);
  assert.equal(ran.length, 0);
  assert.equal(gitRan.length, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^WARN push state filer skipped — the beads task hub is unreachable/);
});

test('a recovered hub says so before it reconciles again', async () => {
  let reachable = false;
  const { lines, deps } = pushDeps({
    countsResult: ok('0\t0\n'),
    deps: { probe: () => Promise.resolve(reachable) },
  });
  await runPushStateFiler(deps);
  reachable = true;
  await runPushStateFiler(deps);
  assert.match(lines[1], /^INFO push state filer resumed \(was skipped: the beads task hub is unreachable\)/);
});

test('a broken task map costs the lane nothing but the lane', async () => {
  const { lines, gitRan, deps } = pushDeps({ deps: { readConfig: () => Promise.resolve('{ not json') } });
  assert.equal(await runPushStateFiler(deps), null);
  assert.equal(gitRan.length, 0);
  assert.match(lines[0], /^WARN push state filer skipped — no beads spokes are configured/);
});

test('a shutting-down runner reconciles nothing', async () => {
  const { ran, gitRan, deps } = pushDeps({ deps: { stopped: () => true } });
  assert.equal(await runPushStateFiler(deps), null);
  assert.equal(ran.length, 0);
  assert.equal(gitRan.length, 0);
});

// The operations contract vs the code: docs/06 may quote the staleness
// constant but must never promise a latency of its own. The threshold is two
// consecutive silent nights, so a single late collector is not an error that
// resolves itself by morning; this pins the doc to it because nothing else
// reads the doc.

/** The contract's staleness age, read out of the source rather than imported:
 * this is a plain-node test and `packages/contract` is TypeScript. */
function contractMaxAgeHours() {
  const source = readFileSync(
    path.join(REPO_ROOT, 'packages', 'contract', 'src', 'reporting.ts'),
    'utf8',
  );
  const cadence = /REPORT_CADENCE_HOURS = (\d+)/.exec(source);
  const multiplier = /REPORT_STALE_MULTIPLIER = (\d+)/.exec(source);
  assert.ok(cadence && multiplier, 'reporting.ts must export the cadence and the multiplier');
  return Number(cadence[1]) * Number(multiplier[1]);
}

/** The bullet in docs/06 that makes the promise. */
function freshnessPromise() {
  const doc = readFileSync(path.join(REPO_ROOT, 'docs', '06-operations.md'), 'utf8');
  const start = doc.indexOf('- **Ingest freshness**');
  assert.ok(start >= 0, 'docs/06 must carry the ingest-freshness bullet');
  const end = doc.indexOf('\n- **', start + 1);
  return doc.slice(start, end < 0 ? undefined : end);
}

test('docs/06 promises the freshness latency the code actually delivers', () => {
  const promise = freshnessPromise();
  assert.match(promise, new RegExp(`${contractMaxAgeHours()}h`));
  assert.match(promise, /two nightly cycles/);
  // Any sentence that invents its own number: the doc may quote the constant
  // but must never promise a latency of its own.
  assert.doesNotMatch(promise, /within 24h/);
});

test('docs/06 names where the number lives, so the next change moves one thing', () => {
  const promise = freshnessPromise();
  assert.match(promise, /REPORT_MAX_AGE_HOURS/);
  assert.match(promise, /packages\/contract\/src\/reporting\.ts/);
});


// The readback lane: a closed bet's verdict, carried to the bead that owns its
// reading. Everything is stubbed: no spawn, no network.

const READBACK_SPOKE = { asset: 'meals.example', prefix: 'mp', repo: '../meals.example' };

function readbackDeps(overrides = {}) {
  const lines = [];
  const spawned = [];
  const requests = [];
  const pending = overrides.pending ?? [
    {
      windowId: 'w-1',
      bead: 'mp-f0g.35',
      asset: 'meals.example',
      outcome: 'kill_confirmed',
      comment: 'Watch window kill_confirmed — meals.example\n\nReading: …',
    },
  ];
  delete overrides.pending;
  return {
    lines,
    spawned,
    requests,
    deps: {
      config: { ingestHost: '127.0.0.1', ingestPort: 8791 },
      readToken: () => Promise.resolve('operator-secret'),
      readConfig: () => Promise.resolve(JSON.stringify({ spokes: [READBACK_SPOKE] })),
      run: (argv) => {
        spawned.push(argv);
        return Promise.resolve(ok(''));
      },
      fetchImpl: (url, init) => {
        requests.push({ url, init });
        if (!init || init.method !== 'POST') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ pending }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ posted: [], skipped: [] }) });
      },
      emit: (level, text) => lines.push(`${level} ${text}`),
      repoRoot: '/home/operator/reindex-os',
      ...overrides,
    },
  };
}

test('a verdict reaches its bead in the spoke that owns it, then is stamped', async () => {
  const { lines, spawned, requests, deps } = readbackDeps();
  const result = await runWatchReadbackFiler(deps);

  assert.deepEqual(result.posted, ['w-1']);
  // `-C <repo>`: bead ids are project-scoped, so the comment has to be made
  // from the spoke's own repo or the hub cannot resolve the id.
  assert.deepEqual(spawned, [
    // Resolved from the HOME checkout the inventory is relative to: a runner
    // running from a runtime copy must not look for ../meals.example beside
    // that copy.
    ['-C', '/home/operator/meals.example', 'comment', 'mp-f0g.35', 'Watch window kill_confirmed — meals.example\n\nReading: …'],
  ]);
  // Read, then post — the stamp is the LAST thing that happens.
  assert.equal(requests.length, 2);
  assert.equal(requests[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[1].init.body), { posted: ['w-1'] });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^INFO watch readbacks — 1 verdict\(s\) filed: mp-f0g\.35 kill_confirmed/);
});

test('an empty queue says nothing at all', async () => {
  const { lines, spawned, requests, deps } = readbackDeps({ pending: [] });
  await runWatchReadbackFiler(deps);
  assert.deepEqual(lines, []);
  assert.deepEqual(spawned, []);
  assert.equal(requests.length, 1);
});

test('a failed comment is not stamped, so the next tick tries again', async () => {
  const { lines, requests, deps } = readbackDeps({
    run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'Error: no issue found matching "mp-f0g.35"' }),
  });
  const result = await runWatchReadbackFiler(deps);

  assert.deepEqual(result.posted, []);
  // Nothing posted means nothing stamped: only the read happened.
  assert.equal(requests.length, 1);
  assert.match(lines[0], /^WARN watch readbacks: bd comment exited 1/);
});

test('a verdict for an asset with no spoke is named, never dropped in silence', async () => {
  const { lines, deps } = readbackDeps({
    readConfig: () => Promise.resolve(JSON.stringify({ spokes: [] })),
  });
  const result = await runWatchReadbackFiler(deps);
  assert.deepEqual(result.posted, []);
  assert.match(lines[0], /^WARN watch readbacks: mp-f0g\.35: no beads spoke is configured for meals\.example/);
});

test('comments that landed but could not be stamped say so in one line', async () => {
  const { lines, deps } = readbackDeps({
    fetchImpl: (url, init) => {
      if (!init || init.method !== 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            pending: [
              {
                windowId: 'w-1',
                bead: 'mp-f0g.35',
                asset: 'meals.example',
                outcome: 'ship_confirmed',
                comment: 'Watch window ship_confirmed — meals.example',
              },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    },
  });
  await runWatchReadbackFiler(deps);
  assert.match(lines[0], /filed but NOT stamped \(HTTP 500\)/);
});

// Which providers are still on the environment file.
//
// Provider credentials live in the product; a binding is the legacy fallback.
// Both work, so this is a NOTE and never a warning. What it exists to stop is an
// install quietly staying half-moved, where a green portfolio depends on a
// gitignored file a fresh install would not have.

const providerPayload = (entries) => ({
  providers: entries.map(([id, source]) => ({
    provider: { id },
    credential: { provider: id, source },
  })),
});

test('the startup line names every provider still resolved from the environment file', () => {
  assert.equal(
    legacyEnvLine(
      providerPayload([
        ['google', 'env'],
        ['bing-webmaster', 'store'],
        ['dataforseo', 'env'],
        ['calendar', 'none'],
      ]),
    ),
    'credentials: 2 of 3 still resolve from the environment file (google, dataforseo) — ' +
      'Import them on /integrations, or run pnpm dev:secrets:import',
  );
});

test('a fully moved install is told so, and a first run is told nothing', () => {
  assert.equal(
    legacyEnvLine(providerPayload([['google', 'store'], ['calendar', 'store']])),
    'credentials: all 2 connected provider(s) resolve from the store',
  );
  // Nothing connected at all is a first run. The Integrations page explains that
  // far better than a log line, and a line here would be noise on every boot of
  // a checkout nobody has configured yet.
  assert.equal(legacyEnvLine(providerPayload([['google', 'none']])), null);
  assert.equal(legacyEnvLine({ providers: [] }), null);
  assert.equal(legacyEnvLine(undefined), null);
});

test('it reads the OS itself, and stays silent when the OS cannot answer', async () => {
  const lines = [];
  const emit = (level, line) => lines.push(`${level} ${line}`);
  const runtime = { running: true, ready: true };

  assert.equal(integrationProvidersUrl(CONFIG), `http://127.0.0.1:${CONFIG.towerPort}/api/integrations/providers`);

  const said = await reportLegacyEnvCredentials(runtime, {
    emit,
    url: 'http://tower.test/api/integrations/providers',
    fetchImpl: async () => ({
      ok: true,
      json: async () => providerPayload([['google', 'env']]),
    }),
  });
  assert.match(said, /still resolve from the environment file \(google\)/);
  // A note, not a warning: a legacy binding is working, and an operator sent to
  // fix something that is not broken stops reading the log.
  assert.match(lines[0], /^INFO credentials: /);

  // The Tower being down is its own visible condition; one more line about it
  // here would be noise, and a throw would take the startup path with it.
  const quiet = await reportLegacyEnvCredentials(runtime, {
    emit,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(quiet, null);
  assert.equal(lines.length, 1);
});

// Which config this install is reading.
//
// The same posture as the credentials note above, for the same reason: a Save
// that lands in a file rather than the store is a different OS from the one the
// docs describe, and an install that has applied the migration but never seeded
// is correct, quiet, and indistinguishable from one that has.

test('the config startup line names the files still read from a file', () => {
  assert.equal(
    configStoreLine({
      ready: true,
      documents: [{ file: 'config/tower.json' }, { file: 'config/constants.json' }],
      unseeded: ['config/pull.json'],
    }),
    'config: 2 document(s) read from the store; 1 still read from the file ' +
      '(config/pull.json) — run pnpm config:seed',
  );
});

test('no config table names the migration, and nothing seeded names the command', () => {
  assert.match(configStoreLine({ ready: false }), /apply migration 0029, then pnpm config:seed/);
  assert.match(
    configStoreLine({ ready: true, documents: [], unseeded: ['config/tower.json'] }),
    /nothing is seeded/,
  );
});

test('a fully seeded install still says so, in one line', () => {
  assert.equal(
    configStoreLine({ ready: true, documents: [{ file: 'config/tower.json' }], unseeded: [] }),
    'config: all 1 document(s) read from the store',
  );
  assert.equal(configStoreLine(null), null);
});

test('the config line reads the ingest door, and stays silent when it cannot', async () => {
  const lines = [];
  const emit = (level, line) => lines.push(`${level} ${line}`);
  const runtime = { running: true, ready: true };

  assert.equal(
    configDocumentsUrl(CONFIG),
    `http://${CONFIG.ingestHost}:${CONFIG.ingestPort}/api/config-documents`,
  );

  const said = await reportConfigStore(runtime, {
    emit,
    url: 'http://ingest.test/api/config-documents',
    readToken: async () => 'test-token',
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.authorization, 'Bearer test-token');
      return {
        ok: true,
        json: async () => ({
          ready: true,
          documents: [{ file: 'config/tower.json' }],
          unseeded: [],
        }),
      };
    },
  });
  assert.match(said, /all 1 document\(s\) read from the store/);
  assert.match(lines[0], /^INFO config: /);

  const quietDoor = await reportConfigStore(runtime, {
    emit,
    readToken: async () => 'test-token',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(quietDoor, null);
  // No operator bearer is not a failure either — it is an install that has not
  // finished its first-run setup, which says so far better elsewhere.
  const untokened = await reportConfigStore(runtime, { emit, readToken: async () => null });
  assert.equal(untokened, null);
  assert.equal(lines.length, 1);
});

// The task-map lane: is each project's declared database one the hub holds?
//
// What these guard is not the SQL but the decisions: what counts as drift, what
// refuses to decide at all, and that the answer is a bead somebody will see
// rather than a line nobody reads.

const TASK_MAP_CONFIG = JSON.stringify({
  spokes: [
    { asset: 'root-os', prefix: 'ro', database: 'ro', repo: '.' },
    { asset: 'meals.example', prefix: 'mp', database: 'mp_typo', repo: '../meals.example' },
    { asset: 'nosh.example', prefix: 'nom', repo: '../nom' },
  ],
});

/** The store's answer to "which asset is the OS" (`GET /api/os-asset`), as the
 * lane's `homeAsset` dependency: the fixture's own OS spoke. */
const TASK_MAP_HOME = async () => 'root-os';

/** A `bd` stub that answers by the verb in the argv, and records every call. */
function taskMapBd(answers) {
  const calls = [];
  return {
    calls,
    run: async (argv) => {
      calls.push(argv);
      const verb = argv.includes('sql')
        ? 'sql'
        : argv.includes('create')
          ? 'create'
          : argv.includes('close')
            ? 'close'
            : 'list';
      return answers[verb] ?? { code: 0, stdout: '[]', stderr: '' };
    },
  };
}

test('SHOW DATABASES is read as data, and unreadable output is not an empty hub', () => {
  assert.deepEqual(
    [...parseBeadsDatabases('[{"Database":"ro"},{"Database":"mp"}]')],
    ['ro', 'mp'],
  );
  // A client that labels the column differently is still readable — the row has
  // exactly one value and it is the name.
  assert.deepEqual([...parseBeadsDatabases('[{"database":"ro"}]')], ['ro']);
  // NULL, not an empty set. An empty set would mean every project has drifted,
  // and that is a conclusion only a hub that genuinely answered may license.
  assert.equal(parseBeadsDatabases('not json'), null);
  assert.equal(parseBeadsDatabases('{"rows":[]}'), null);
});

test('drift is a declared name the hub does not hold — and a missing name too', () => {
  const spokes = parseBeadsProjects(TASK_MAP_CONFIG);
  const held = new Set(['ro', 'mp', 'information_schema', 'mysql']);

  assert.deepEqual(beadsDatabaseDrift(spokes, held), [
    // "mp_typo" is a plausible-looking name that is simply not there.
    { asset: 'meals.example', declared: 'mp_typo' },
    // No database at all is drift too, and the more urgent kind: the backup
    // lane drops this project silently, so it is not being copied and nothing
    // says so.
    { asset: 'nosh.example', declared: null },
  ]);
  // A hub we could not ask decides nothing.
  assert.deepEqual(beadsDatabaseDrift(spokes, null), []);
});

test('a drift bead is identified by its project, metadata first and title second', () => {
  assert.equal(
    taskMapBeadAsset({ metadata: { [TASK_MAP_ASSET_KEY]: 'nosh.example' }, title: 'anything' }),
    'nosh.example',
  );
  // `bd`'s list JSON omits metadata for a bead that carries none; reading a
  // thinner client's bead beats filing a duplicate beside it.
  assert.equal(taskMapBeadAsset({ title: taskMapTitle('meals.example') }), 'meals.example');
  assert.equal(taskMapBeadAsset({ title: 'Something else entirely' }), null);

  // AND THE TOWER READS THE SAME TITLE. /settings#task-hub marks the row whose
  // database the hub does not hold, and it learns which one from the bead this
  // lane files; its matcher (`driftingAssetOf` in apps/tower/shared/task-map.ts)
  // keys on this prefix, so it is pinned HERE, on the writing side.
  assert.match(taskMapTitle('nosh.example'), /^Point nosh\.example's task database at one\b/);

  const open = taskMapOpenBeads([
    { id: 'ro-1', status: 'open', metadata: { [TASK_MAP_ASSET_KEY]: 'nosh.example' } },
    { id: 'ro-2', status: 'closed', metadata: { [TASK_MAP_ASSET_KEY]: 'fees.example' } },
    { id: 'ro-3', status: 'open', title: 'unrelated work' },
  ]);
  assert.deepEqual([...open], [['nosh.example', 'ro-1']]);
  // Null forbids both filing and closing this pass.
  assert.equal(taskMapOpenBeads('nope'), null);
});

test('the lane files one bead per drifting project, into this repo', async () => {
  const lines = [];
  const bd = taskMapBd({
    sql: { code: 0, stdout: '[{"Database":"ro"},{"Database":"mp"}]', stderr: '' },
    list: { code: 0, stdout: '[]', stderr: '' },
    create: { code: 0, stdout: '{"id":"ro-new"}', stderr: '' },
  });

  const result = await runTaskMapCheck({
    homeAsset: TASK_MAP_HOME,
    readConfig: async () => TASK_MAP_CONFIG,
    run: bd.run,
    now: () => new Date('2026-09-05T05:00:00.000Z'),
    state: { skipping: null },
    emit: (level, line) => lines.push(`${level} ${line}`),
    stopped: () => false,
  });

  assert.deepEqual(
    result.filed.map((f) => f.asset),
    ['meals.example', 'nosh.example'],
  );
  const created = bd.calls.filter((argv) => argv.includes('create'));
  assert.equal(created.length, 2);
  // Filed into THIS repo's tracker: the wrong value is in this repo's file and
  // the lane it breaks is this repo's backup.
  assert.equal(created[0][1], REPO_ROOT);
  assert.ok(created[0].includes(TASK_MAP_ACTOR));
  // `human`, because only the operator can run `bd init` or change the value.
  assert.ok(created[0].some((arg) => arg === `${TASK_MAP_LABEL},${TASK_MAP_HUMAN_LABEL}`));
  // The description carries both fixes and the names the hub actually has.
  const description = created[0][created[0].indexOf('--description') + 1];
  assert.match(description, /provision that database from the project checkout/);
  assert.match(description, /installation\/task-host\.json/);
  assert.match(description, /\/settings#task-hub/);
  assert.match(description, /the hub holds: mp, ro/);
  // ERROR, not WARN: the backup for this project is aimed at nothing.
  assert.ok(lines.some((line) => line.startsWith('ERROR task map: meals.example')));
});

test('a bead already open for a project is kept rather than filed again', async () => {
  const bd = taskMapBd({
    sql: { code: 0, stdout: '[{"Database":"ro"},{"Database":"mp"}]', stderr: '' },
    list: {
      code: 0,
      stdout: JSON.stringify([
        { id: 'ro-old', status: 'open', metadata: { [TASK_MAP_ASSET_KEY]: 'meals.example' } },
        { id: 'ro-old2', status: 'open', metadata: { [TASK_MAP_ASSET_KEY]: 'nosh.example' } },
      ]),
      stderr: '',
    },
  });

  const result = await runTaskMapCheck({
    homeAsset: TASK_MAP_HOME,
    readConfig: async () => TASK_MAP_CONFIG,
    run: bd.run,
    state: { skipping: null },
    emit: () => {},
    stopped: () => false,
  });

  assert.deepEqual(result.filed, []);
  assert.deepEqual(result.closed, []);
  assert.equal(bd.calls.filter((argv) => argv.includes('create')).length, 0);
});

test('the lane closes its own bead when the two agree again, with the evidence', async () => {
  const bd = taskMapBd({
    // The hub now holds every declared database.
    sql: {
      code: 0,
      stdout: '[{"Database":"ro"},{"Database":"mp"}]',
      stderr: '',
    },
    list: {
      code: 0,
      stdout: JSON.stringify([
        { id: 'ro-old', status: 'open', metadata: { [TASK_MAP_ASSET_KEY]: 'meals.example' } },
      ]),
      stderr: '',
    },
    close: { code: 0, stdout: '', stderr: '' },
  });
  const agreeing = JSON.stringify({
    spokes: [
      { asset: 'root-os', prefix: 'ro', database: 'ro', repo: '.' },
      { asset: 'meals.example', prefix: 'mp', database: 'mp', repo: '../meals.example' },
    ],
  });

  const result = await runTaskMapCheck({
    homeAsset: TASK_MAP_HOME,
    readConfig: async () => agreeing,
    run: bd.run,
    now: () => new Date('2026-09-05T05:00:00.000Z'),
    state: { skipping: null },
    emit: () => {},
    stopped: () => false,
  });

  assert.deepEqual(result.closed, [{ asset: 'meals.example', beadId: 'ro-old' }]);
  const closed = bd.calls.find((argv) => argv.includes('close'));
  const reason = closed[closed.indexOf('-r') + 1];
  assert.match(reason, /SHOW DATABASES/);
  assert.match(reason, /2026-09-05T05:00:00\.000Z/);
  // Recurrence is a FRESH bead, said out loud in the close itself.
  assert.match(reason, /files a fresh bead rather than reopening this one/);
});

test('a hub that will not answer decides nothing at all', async () => {
  for (const sql of [
    { code: 1, stdout: '', stderr: 'connection refused' },
    { code: 0, stdout: 'not json', stderr: '' },
  ]) {
    const bd = taskMapBd({ sql });
    const result = await runTaskMapCheck({
      homeAsset: TASK_MAP_HOME,
      readConfig: async () => TASK_MAP_CONFIG,
      run: bd.run,
      state: { skipping: null },
      emit: () => {},
      stopped: () => false,
    });
    assert.equal(result, null);
    // Nothing filed, nothing closed, and the bead list was never even asked
    // for: a bead filed against a hub we could not read is the same lie as
    // silence, in the other direction.
    assert.equal(bd.calls.length, 1);
  }
});

// The lane files into the OS's own project as the STORE names it
// (`assets.is_os`), whatever that asset is called, and files nothing when the
// store names none rather than guessing an id.
test('the lane files into whichever project the store names as the OS', async () => {
  const bd = taskMapBd({
    sql: { code: 0, stdout: '[{"Database":"home"}]', stderr: '' },
    list: { code: 0, stdout: '[]', stderr: '' },
    create: { code: 0, stdout: '{"id":"home-new"}', stderr: '' },
  });
  const renamed = JSON.stringify({
    spokes: [
      { asset: 'home-os.example', prefix: 'home', database: 'home', repo: '.' },
      { asset: 'shop.example', prefix: 'shop', database: 'shop', repo: '../shop' },
    ],
  });
  const result = await runTaskMapCheck({
    homeAsset: async () => 'home-os.example',
    readConfig: async () => renamed,
    run: bd.run,
    now: () => new Date('2026-09-05T05:00:00.000Z'),
    state: { skipping: null },
    emit: () => {},
    stopped: () => false,
  });
  assert.deepEqual(result.filed.map((f) => f.asset), ['shop.example']);
  const created = bd.calls.find((argv) => argv.includes('create'));
  assert.equal(created[1], REPO_ROOT, 'filed into the OS project’s own checkout');

  const lines = [];
  const unnamed = taskMapBd({});
  assert.equal(
    await runTaskMapCheck({
      homeAsset: async () => null,
      readConfig: async () => renamed,
      run: unnamed.run,
      state: { skipping: null },
      emit: (level, line) => lines.push(`${level} ${line}`),
      stopped: () => false,
    }),
    null,
  );
  assert.equal(unnamed.calls.length, 0, 'the hub is never asked when there is no OS project');
  assert.ok(lines.some((line) => line.includes('the store names no OS asset')));
});

// --- starting from a runtime copy ---------------------------------------------
//
// The managed service runs a runtime copy of the code. Before that runner starts
// anything, its copy must be linked to home's state. The following Postgres
// validation independently refuses a missing login or unprepared database.

test('a runner copy requires shared links and no legacy D1 files', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'os-up-home-'));
  try {
    const copy = path.join(home, '.local', 'runtime', 'runtime-a');
    // Postgres validation is the next startup step, independent of D1 files.
    assert.equal(await runtimeCopyRefusal({ codeRoot: copy, homeRoot: home }), null);
    assert.equal(existsSync(path.join(home, '.wrangler', 'state', 'v3', 'd1')), false);
    assert.equal(existsSync(path.join(copy, '.local')), true, 'the copy was linked to home’s .local');

    // A conflicting real directory in the copy: refused, nothing deleted.
    const conflicted = await runtimeCopyRefusal({
      codeRoot: copy,
      homeRoot: home,
      ensureLinks: async () => ({
        created: [],
        linked: [],
        conflicts: [{ path: '.wrangler', what: 'the local R2 archive', reason: 'is a real directory, not a link to x' }],
      }),
    });
    assert.match(conflicted, /\.wrangler is a real directory/u);

    // From home itself there is nothing to prove.
    assert.equal(await runtimeCopyRefusal({ codeRoot: home, homeRoot: home }), null);
    assert.equal(EXIT_RUNTIME_COPY, 4, 'distinct from 2 (bad flags) and 3 (already running)');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the runner records which code it is, for os:status and os:deploy', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'scripts', 'os-up.mjs'), 'utf8');
  const state = source.slice(source.indexOf('const runnerState = {'), source.indexOf('};', source.indexOf('const runnerState = {')));
  for (const field of ['codeRoot: REPO_ROOT', 'homeRoot: HOME_ROOT', 'commit: null']) {
    assert.ok(state.includes(field), `the heartbeat no longer carries ${field}`);
  }
  assert.match(source, /runnerState\.commit = codeCommit\(\);/u);
  // The tower child is handed home's store and home checkout, and the
  // database's address.
  assert.match(source, /env: \{ \.\.\.ingestDoorEnv\(config\), \.\.\.runtimeChildEnv\(HOME_ROOT\), \.\.\.database \}/u);
});

// An expression no scheduled job runs on is refused by the dispatch and runs
// nothing; the runner and `pnpm os:cron` say so by name.
test('a refused cron fire is failed by its name, in the run record and the log', async () => {
  const lines = [];
  const refused = await fireScheduledTrigger('http://127.0.0.1:8599', '7 7 7 7 7', {
    fetchImpl: async () => new Response(JSON.stringify({ error: 'unknown_cron', cron: '7 7 7 7 7', message: 'No scheduled job runs on "7 7 7 7 7".' }), { status: 400 }),
    emit: (level, text) => lines.push(`${level} ${text}`),
  });
  assert.deepEqual(refused, { outcome: 'failed', detail: 'HTTP 400 · unknown_cron' });
  assert.deepEqual(lines, ['ERROR cron "7 7 7 7 7" fired → HTTP 400 · unknown_cron (non-200)']);

  // A door that names no code keeps the bare status.
  const bare = await fireScheduledTrigger('http://127.0.0.1:8599', '0 * * * *', {
    fetchImpl: async () => new Response('gateway down', { status: 502 }),
  });
  assert.deepEqual(bare, { outcome: 'failed', detail: 'HTTP 502' });
  assert.equal(doorErrorCode('{"error":"Bearer abc def"}'), null, 'only a code-shaped value is repeated');
});

test('os:cron names the refusal and lists the expressions it does run', () => {
  const line = tickRefusal('0 * * * * *', 'unknown_cron');
  assert.match(line, /^tick: refused "0 \* \* \* \* \*" — unknown_cron: no scheduled job runs on it; nothing ran\./u);
  assert.match(line, /"0 \* \* \* \*" \(Data freshness checks\)/u);
  assert.doesNotMatch(line, /Search review tasks/u, 'a job the runner runs itself is not an expression os:cron fires');
  assert.equal(tickRefusal('0 * * * *', 'scheduled_failed'), null);
  assert.equal(tickRefusal('0 * * * *', null), null);
});
