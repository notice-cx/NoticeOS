#!/usr/bin/env node
// os-up.mjs — the NoticeOS LOCAL RUNNER / supervisor.
//
// "The OS runs on the operator's Mac for a while" made true. It:
//   - refuses to start at all when another runner already holds the ingest port
//     (two runners = every cron fired twice),
//   - never applies migrations: those are an explicit operator-only command,
//   - starts nothing without its Postgres: DATABASE_URL, read from home's
//     secrets file and checked as the application login, rides in the Tower
//     child's environment and nowhere else; a missing or unusable address, or
//     a database behind this code, stops it in one sentence (runner/database.mjs),
//     and it never applies a Postgres migration either,
//   - spawns + supervises ONE child: the tower (vite), whose workerd runtime
//     hosts BOTH Workers — the Tower as the entry Worker and the ingest as an
//     auxiliary Worker beside it. That is deliberate and load-bearing: two
//     Workers share one supervised runtime and one ingest door. The runner
//     arms schedules only after proving that its own child holds that door,
//   - health-checks the beads task hub (hosted by `brew services`, not us) and
//     photographs it once a minute into the central store for the Tower's
//     read-only /work board,
//   - files the signal review bead into a property's own tracker when its weekly
//     DataForSEO collection lands, panel or no panel (one of the two lanes here
//     that WRITE a bead),
//   - reconciles every spoke's "unpushed commits" bead against the live push
//     state — files one when commits sit unpushed too long, closes it when the
//     push lands — and evaluates that spoke's gates on the same tick (the other
//     bead-writing lane, and the only one that also CLOSES),
//   - rebuilds every rostered property's local signal panels on a cadence
//     (config/signal-panels.json, docs/20-signal-panels.md) — the flatten half
//     of the signals lane, which a Worker cron cannot do because a Worker cannot
//     write this machine's disk,
//   - restarts a child that dies (backoff, then gives up loudly),
//   - schedules the ingest crons (read from workers/ingest/wrangler.jsonc, UTC)
//     and fires them against the local scheduled endpoint — each fire proving
//     first that its OWN child holds the ingest door, so a runner that lost a
//     bind race stands down instead of doubling somebody else's schedule,
//   - keeps a job-run record (.local/logs/job-runs.jsonl): one line per lane per
//     firing (ran/skipped/failed, when, how long), read back at startup so a
//     lane that died is a last-run that stopped moving rather than a silence,
//   - runs a nightly backup (Postgres + the R2 raw-archive store + every task-hub
//     database, plus approved asset exports) with host-configured retention,
//     copying the finished dir to the
//     offsite folder this host names (its installation's host-backup.json),
//   - shuts down cleanly on SIGINT/SIGTERM.
//
// Plain Node ESM — no TypeScript, no build step. Run via `pnpm os:up`.
// Modes:  (default) supervise with loopback Tower · --host (network Tower) ·
// --tick "<expr>" (os:cron) · --backup (os:backup)
//
// See scripts/README.md for the port map, cron behavior, backups + restore
// drill, and the launchd install.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncDevVarsIfPresent } from './dev-secrets.mjs';
import { runBackup as backupHost, backupRunOutcome } from './host-backup.mjs';
import { requestContainerBackup } from './container-backup-channel.mjs';
import { doorErrorCode, localDoorFetch } from './ingest-door.mjs';
import { createDeployForwardState, deployLogSource, forwardOsDeploysToStore } from './os-deploy-forward.mjs';
import { invokedDirectly, runtimeChildEnv, samePath } from './os-runtime.mjs';
import { readProductEnv } from './product-env.mjs';
import { SCHEDULED_JOBS } from './scheduled-jobs.mjs';
// What this file coordinates, one responsibility per module under
// scripts/runner/ (docs/briefs/2026-09-24-runner-modules.md). CONFIG — the port
// map and every knob — and where this runner's code and state are live in
// scripts/runner/config.mjs.
import {
  BACKUPS_DIR,
  BEADS_DOLT_DIR,
  CONFIG,
  HOME_ROOT,
  LOGS_DIR,
  REPO_ROOT,
  RUNNER_STATE_FILE,
  SECRET_FILES,
  STATE,
} from './runner/config.mjs';
import { runnerDatabase } from './runner/database.mjs';
import { towerDependenciesReady, towerLaunch } from './runner/tower-launch.mjs';
import { bdBin, gitBin, probeTcp } from './runner/host-tools.mjs';
import { armJobRunShipping, jobRunsUrl, reportJobRuns, runJobLane } from './runner/job-record.mjs';
import {
  EXIT_ALREADY_RUNNING,
  EXIT_NO_DATABASE,
  EXIT_RUNTIME_COPY,
  beginShutdown,
  ingestDoorEnv,
  isShuttingDown,
  readPreviousRunnerState,
  recoverManagedOrphan,
  runnerArmDecision,
  runtimeCopyRefusal,
} from './runner/lifecycle.mjs';
import { closeLog, log, openLog, ts, writeLine } from './runner/log.mjs';
import { operatorToken } from './runner/operator-token.mjs';
import { runPanelRefresh } from './runner/panel-refresh.mjs';
import { runPanelReviewFiler } from './runner/panel-review.mjs';
import { runPushStateFiler } from './runner/push-state.mjs';
import { scheduledUrl, startScheduler, stopScheduler, trackTimer, waitForRuntime } from './runner/scheduler.mjs';
import { reportConfigStore, reportLegacyEnvCredentials } from './runner/startup-report.mjs';
import { checkBeadsHub, taskHubPortDescription } from './runner/task-hub.mjs';
import { runTaskMapCheck } from './runner/task-map.mjs';
import { runBeadsPoll } from './runner/task-snapshot.mjs';
import { runWatchReadbackFiler } from './runner/watch-readbacks.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// The names this file has always exported, for the code that imports them from
// here (the root tests, scripts/start-host-lanes.mjs). Each is defined in the
// module it is re-exported from.
// ─────────────────────────────────────────────────────────────────────────────
export {
  JOB_RUN_CATCHUP_DAYS,
  JOB_RUN_OUTCOMES,
  JOB_RUN_PENDING_MAX,
  JOB_RUN_RETENTION_DAYS,
  JOB_RUN_SHIP_MAX,
  createCatchupOwnership,
  jobRunCatchup,
  jobRunCutoff,
  jobRunLine,
  jobRunPostBody,
  jobRunQueued,
  jobRunRecord,
  jobRunShippable,
  parseJobRuns,
  pruneJobRuns,
  scheduledCatchupPolicies,
  scheduledDuringCatchupDecision,
} from './job-runs.mjs';
export { beadsDatabaseName } from './task-project-config.mjs';
export { CONFIG, osCheckoutName, runnerPaths } from './runner/config.mjs';
export { LOG_LINE_MAX_CHARS, LOG_MAX_BYTES, LOG_ROTATIONS, rotateLogFile } from './runner/log.mjs';
export { bdBin, probeTcp, resolveBin } from './runner/host-tools.mjs';
export {
  cronFireDecision,
  doorOwnershipDecision,
  isDescendantOf,
  listenerOwnersArgs,
  parseListenerOwners,
  parseProcessParents,
} from './runner/door-ownership.mjs';
export {
  EXIT_ALREADY_RUNNING,
  EXIT_NO_DATABASE,
  EXIT_RUNTIME_COPY,
  MANAGED_ORPHAN_MAX_AGE_MS,
  ingestDoorEnv,
  managedOrphanDecision,
  runnerArmDecision,
  runtimeCopyRefusal,
} from './runner/lifecycle.mjs';
export {
  armJobRunShipping,
  jobRunAge,
  jobRunStartupLines,
  jobRunsUrl,
  reportJobRuns,
  runJobLane,
  shipJobRuns,
  summarizeJobRuns,
} from './runner/job-record.mjs';
export {
  configDocumentsUrl,
  configStoreLine,
  integrationProvidersUrl,
  legacyEnvLine,
  reportConfigStore,
  reportLegacyEnvCredentials,
} from './runner/startup-report.mjs';
export {
  beadsCreatedId,
  beadsHubDiagnosis,
  beadsHubHealthLine,
  beadsSkipDecision,
  parseBeadsProjects,
  parseBeadsSpokes,
  parseDoltServers,
  runBd,
} from './runner/task-hub.mjs';
export {
  COLLECTION_REVIEW_ACCEPTANCE,
  INVALID_PANEL_REVIEW_LABEL,
  PANEL_REVIEW_ACCEPTANCE,
  PANEL_REVIEW_ACTOR,
  PANEL_REVIEW_ASSET_KEY,
  PANEL_REVIEW_DATE_KEY,
  PANEL_REVIEW_DUE_DAYS,
  PANEL_REVIEW_LABEL,
  PANEL_REVIEW_LIMIT,
  invalidPanelReview,
  panelReviewAcceptance,
  panelReviewAlreadyFiled,
  panelReviewCreateArgs,
  panelReviewCreatedId,
  panelReviewDescription,
  panelReviewDueDate,
  panelReviewEntry,
  panelReviewListArgs,
  panelReviewPanelDate,
  panelReviewTitle,
  parsePanelLandings,
  runPanelReviewFiler,
  serpPanelLandingsUrl,
} from './runner/panel-review.mjs';
export {
  BEADS_CLOSED_LIMIT,
  BEADS_CLOSED_WINDOW_DAYS,
  BEADS_CONTAINER_TYPE,
  BEADS_CREATED_LIMIT,
  BEADS_DEFERRED_LIMIT,
  BEADS_DEFERRED_STATUS,
  BEADS_EPIC_LIMIT,
  BEADS_HIGH_PRIORITY_MAX,
  BEADS_HUMAN_GATE,
  BEADS_IN_PROGRESS_LIMIT,
  BEADS_OPTIONAL_READS,
  BEADS_PRIORITY_BANDS,
  BEADS_READY_LIMIT,
  BEADS_WAITING_LIMIT,
  HANDOFF_ASSET_FIELD,
  HANDOFF_KEY_FIELD,
  HANDOFF_KIND_FIELD,
  HANDOFF_KINDS,
  HANDOFF_LABEL,
  HANDOFF_LIMIT,
  beadsClosedSince,
  beadsGateReason,
  beadsPollArgs,
  beadsProjectError,
  beadsSnapshotUrl,
  collectBeadsSnapshot,
  handoffEntries,
  handoffListArgs,
  runBeadsPoll,
  summarizeBeadsProject,
} from './runner/task-snapshot.mjs';
export { runWatchReadbackFiler, watchReadbacksUrl } from './runner/watch-readbacks.mjs';
export {
  PUSH_STATE_ACCEPTANCE,
  PUSH_STATE_ACTOR,
  PUSH_STATE_ASSET_KEY,
  PUSH_STATE_BRANCH,
  PUSH_STATE_COMMIT_LIMIT,
  PUSH_STATE_HUMAN_LABEL,
  PUSH_STATE_LABEL,
  PUSH_STATE_REMOTE,
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
  pushStateTitle,
  pushStateUnreadReason,
  runPushStateFiler,
} from './runner/push-state.mjs';
export {
  TASK_MAP_ACCEPTANCE,
  TASK_MAP_ACTOR,
  TASK_MAP_ASSET_KEY,
  TASK_MAP_HUMAN_LABEL,
  TASK_MAP_LABEL,
  TASK_MAP_SYSTEM_DATABASES,
  beadsDatabaseDrift,
  beadsShowDatabasesArgs,
  parseBeadsDatabases,
  runTaskMapCheck,
  taskMapBeadAsset,
  taskMapCloseArgs,
  taskMapCloseReason,
  taskMapCreateArgs,
  taskMapDescription,
  taskMapHomeAsset,
  taskMapListArgs,
  taskMapOpenBeads,
  taskMapTitle,
} from './runner/task-map.mjs';
export { runPanelRefresh } from './runner/panel-refresh.mjs';
export { STARTUP_CATCHUP_POLICIES, startupCatchupPlan } from './runner/scheduler.mjs';

async function ensureDirs() {
  await fs.mkdir(LOGS_DIR, { recursive: true });
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
  await fs.mkdir(BEADS_DOLT_DIR, { recursive: true });
}

const runnerState = {
  schemaVersion: 1,
  pid: process.pid,
  managed: readProductEnv(process.env, 'managed') === '1',
  startedAt: null,
  updatedAt: null,
  status: 'starting',
  towerReady: false,
  towerPid: null,
  schedulerArmed: false,
  // Which code this runner is (bead ro-ujb9.113): `pnpm os:status` compares the
  // commit with main, and `pnpm os:deploy` requires the restarted runner to
  // report the commit it deployed.
  codeRoot: REPO_ROOT,
  homeRoot: HOME_ROOT,
  commit: null,
};

/** The commit this runner's code is checked out at, or null when git cannot say. */
function codeCommit() {
  const result = spawnSync(gitBin(), ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const commit = String(result.stdout ?? '').trim();
  return result.status === 0 && /^[0-9a-f]{40,64}$/u.test(commit) ? commit : null;
}

async function writeRunnerState(patch = {}) {
  Object.assign(runnerState, patch, { updatedAt: ts() });
  try {
    await fs.writeFile(RUNNER_STATE_FILE, `${JSON.stringify(runnerState)}\n`, { mode: 0o600 });
  } catch {
    // The status file is diagnostic state; it must never take down the runner.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Child supervision. Each child is a plain object; spawn detached so it leads
// its own process group and we can group-kill wrangler→workerd / vite cleanly.
// ─────────────────────────────────────────────────────────────────────────────

function makeChild({ tag, command, cwd, args, readyMatcher, env = {} }) {
  return {
    tag,
    command,
    cwd,
    args,
    readyMatcher,
    // Extra environment on top of ours. The tower's runtime learns the ingest
    // door's address this way, so CONFIG above stays the one port map.
    env,
    proc: null,
    running: false,
    ready: false,
    restarts: 0,
    startedAt: 0,
    readyTimer: null,
    gaveUp: false,
  };
}

/**
 * The ONLY child. Its vite dev server runs one workerd hosting both Workers —
 * the Tower as the entry Worker, the ingest as an auxiliary Worker
 * (apps/tower/vite.config.ts). It also binds the loopback ingest door at
 * config.ingestHost:config.ingestPort, which is the address every line below
 * (crons, snapshots, panel reads) still fires at.
 *
 * Its arguments name ports and a host, never a secret. Its environment carries
 * the door address, where the store and the home checkout are (a runtime
 * copy's dev server opens home's store and its local lanes read and commit in
 * home, scripts/os-runtime.mjs; from home itself these are the paths the dev
 * server has always defaulted to), and the database's address `database`
 * (scripts/database-address.mts), which travels nowhere else. Exported so a
 * rehearsal starts exactly this child on ports of its own.
 */
export function towerChild({ config = CONFIG, exposeTowerToLan, database }) {
  const launch = towerLaunch(REPO_ROOT);
  const args = [
    launch.entry,
    '--port',
    String(config.towerPort),
    '--strictPort', // honor the pinned port or fail loudly (don't drift to 5174)
  ];
  args.push('--host', exposeTowerToLan ? config.towerLanHost : '127.0.0.1');
  return makeChild({
    tag: 'tower',
    command: launch.command,
    cwd: launch.cwd,
    args,
    env: { ...ingestDoorEnv(config), ...runtimeChildEnv(HOME_ROOT), ...database },
    // vite prints "VITE vX ready in …" and "➜  Local: http://localhost:5173/".
    readyMatcher: /ready in|Local:\s+http|VITE v/i,
  });
}

function pipeStream(stream, child) {
  stream.setEncoding('utf8');
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      writeLine(`[${child.tag}]`, line);
      if (!child.ready && child.readyMatcher.test(line)) {
        child.ready = true;
        log('INFO', `${child.tag} ready`);
        if (child.tag === 'tower') {
          void writeRunnerState({
            towerReady: true,
            status: runnerState.schedulerArmed ? 'healthy' : 'starting',
          });
        }
      }
    }
  });
}

/** Start `child` supervised: its output into the redacted log, its heartbeat
 * fields, restarts with backoff. Exported, with `killChild`, so a rehearsal
 * supervises `towerChild` exactly as the runner does. */
export async function startChild(child) {
  if (!await towerDependenciesReady({ root: REPO_ROOT })) {
    child.gaveUp = true;
    log('ERROR', 'REFUSING to start Tower: prepared dependencies are unavailable or stale; run pnpm install --frozen-lockfile explicitly');
    return false;
  }
  if (isShuttingDown()) return false;
  child.ready = false;
  child.startedAt = Date.now();
  const proc = spawn(child.command, child.args, {
    cwd: child.cwd,
    env: { ...process.env, ...child.env },
    detached: true, // own process group → clean group kill on shutdown
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.proc = proc;
  child.running = true;
  if (child.tag === 'tower') {
    void writeRunnerState({ towerPid: proc.pid ?? null, towerReady: false, status: 'starting' });
  }

  // Fallback readiness: if the banner never matches, assume ready after a grace
  // period so cron fires aren't skipped forever on a banner-format change.
  child.readyTimer = setTimeout(() => {
    if (child.running && !child.ready) {
      child.ready = true;
      log('INFO', `${child.tag} assumed ready after ${CONFIG.readyGraceMs}ms (no banner match)`);
      if (child.tag === 'tower') {
        void writeRunnerState({
          towerReady: true,
          status: runnerState.schedulerArmed ? 'healthy' : 'starting',
        });
      }
    }
  }, CONFIG.readyGraceMs);

  pipeStream(proc.stdout, child);
  pipeStream(proc.stderr, child);

  proc.on('error', (err) => {
    log('ERROR', `${child.tag} spawn error: ${err.message}`);
  });

  // 'exit', not 'close' (scripts/run-command.mjs): the supervisor watches the
  // child's life, not an answer, and a process it started can hold the pipe
  // after it died.
  proc.on('exit', (code, signal) => {
    child.running = false;
    child.ready = false;
    if (child.tag === 'tower') {
      void writeRunnerState({ towerReady: false, status: 'unhealthy' });
    }
    if (child.readyTimer) clearTimeout(child.readyTimer);
    if (isShuttingDown() || child.gaveUp) return;

    const uptime = Date.now() - child.startedAt;
    if (uptime < CONFIG.rapidWindowMs) {
      child.restarts += 1;
    } else {
      child.restarts = 0; // a healthy run clears the strike count
    }

    if (child.restarts > CONFIG.maxRapidRestarts) {
      child.gaveUp = true;
      log(
        'ERROR',
        `${child.tag} died ${CONFIG.maxRapidRestarts}+ times in a row within ${CONFIG.rapidWindowMs}ms each — GIVING UP. ` +
          `Fix the cause and restart os:up.`,
      );
      return;
    }

    const backoff = Math.min(500 * 2 ** Math.max(0, child.restarts - 1), 8000);
    log(
      'WARN',
      `${child.tag} exited (code=${code} signal=${signal}); restart #${child.restarts} in ${backoff}ms`,
    );
    setTimeout(() => {
      if (!isShuttingDown() && !child.gaveUp) void startChild(child);
    }, backoff);
  });

  log('INFO', `${child.tag} started (pid ${proc.pid})`);
  return true;
}

export function killChild(child, signal) {
  if (!child.proc || !child.running) return;
  try {
    // Negative pid → the whole process group (child + its grandchildren).
    process.kill(-child.proc.pid, signal);
  } catch {
    try {
      child.proc.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

function waitForExit(children, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (children.every((c) => !c.running) || Date.now() - start > timeoutMs) {
        clearInterval(iv);
        resolve();
      }
    }, 100);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Backup — the module owns copy completeness; the runner schedules and records.
// ─────────────────────────────────────────────────────────────────────────────
async function runBackup() {
  // The offsite folder is the home installation's host-backup.json, read by the
  // backup itself (scripts/host-backup.mjs), so an edit applies at the next run.
  const result = process.env.NOTICEOS_BACKUP_CLIENT_PROFILE !== undefined
    ? await requestContainerBackup(process.env.NOTICEOS_BACKUP_CLIENT_PROFILE)
    : await backupHost({
    repoRoot: HOME_ROOT,
    retentionDays: CONFIG.backupRetentionDays,
    bdBinary: bdBin(),
    ...(process.env.NOTICEOS_DOLT_HOME !== undefined ? { doltHome: process.env.NOTICEOS_DOLT_HOME } : {}),
  });
  log(result.ok ? 'INFO' : 'ERROR', `backup: ${result.detail}`);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// The host lanes — what each local scheduled job runs, for the scheduler
// (scripts/runner/scheduler.mjs), which decides only when. `outcomeOf` turns a
// lane's result into its job-run outcome; without one, null is a skip.
// Exported so a test can prove every local job has exactly one body here.
// ─────────────────────────────────────────────────────────────────────────────
export function hostLanes(runtime) {
  return {
    'beads-hub': {
      run: () => checkBeadsHub(),
      outcomeOf: (reachable) => ({ outcome: 'ran', detail: reachable ? 'hub reachable' : 'hub down' }),
    },
    'beads-snapshot': { run: () => runBeadsPoll(runtime) },
    'panel-review': { run: () => runPanelReviewFiler(runtime) },
    'push-state': { run: () => runPushStateFiler() },
    'watch-readbacks': { run: () => runWatchReadbackFiler() },
    'task-map': { run: () => runTaskMapCheck() },
    'panel-refresh': { run: () => runPanelRefresh(runtime) },
    backup: { run: () => runBackup(), outcomeOf: backupRunOutcome },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// OS deploys → the store (bead ro-trai.8)
//
// `pnpm os:deploy` records every move of the live OS in this host's deploy log;
// the Wall feed reads only the store. Once a minute the runner forwards what
// the log holds, as annotations on the OS asset, through the ingest's own
// annotation route (scripts/os-deploy-forward.mjs). A deploy restarts this
// runner, and the record of a failed deploy's automatic rollback is written
// after the new runner is up — so a start-up pass alone would miss it.
// ─────────────────────────────────────────────────────────────────────────────

/** How often the deploy log is re-read. */
export const DEPLOY_FORWARD_INTERVAL_MS = 60_000;
const deployForwardState = createDeployForwardState();

async function forwardDeploysOnce(runtime) {
  if (isShuttingDown() || !runtime.running || !runtime.ready) return;
  try {
    // Filed against asset #0, the OS itself, as the store names it
    // (`assets.is_os`, beads ro-k9hf / ro-ujb9.118) — never an id written here.
    const result = await forwardOsDeploysToStore({
      source: deployLogSource(STATE.deploysFile),
      config: CONFIG,
      readToken: operatorToken,
      state: deployForwardState,
    });
    if (result?.sent) log('INFO', `OS deploys → store: ${result.sent} recorded for the Wall feed`);
  } catch (err) {
    log('WARN', `OS deploy forwarding failed: ${err?.message ?? err}`);
  }
}

function startDeployForwarding(runtime) {
  const timer = setInterval(() => void forwardDeploysOnce(runtime), DEPLOY_FORWARD_INTERVAL_MS);
  trackTimer(timer);
  void waitForRuntime(runtime)
    .then(() => forwardDeploysOnce(runtime))
    .catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Modes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What `pnpm os:cron` says when the dispatch refused the expression (bead
 * ro-ujb9.217): the refusal by name, then the expressions it does run, so a
 * typo is fixed from the same screen. Null for any other failure.
 */
export function tickRefusal(expr, code) {
  if (code !== 'unknown_cron') return null;
  const known = SCHEDULED_JOBS.filter((job) => !job.local).map((job) => `"${job.cron}" (${job.label})`);
  return `tick: refused "${expr}" — unknown_cron: no scheduled job runs on it; nothing ran. Scheduled: ${known.join(', ')}`;
}

// os:cron — fire one scheduled endpoint immediately and exit. Assumes os:up is
// already running, with its tower child holding the ingest door on the pinned
// port.
async function tickOnce(expr) {
  const url = scheduledUrl(expr);
  log('INFO', `tick: firing "${expr}" → ${url}`);
  try {
    const res = await localDoorFetch(url, { method: 'GET' });
    const text = await res.text();
    const body = text.slice(0, 200);
    if (res.ok) {
      log('INFO', `tick: HTTP ${res.status}${body ? ' · ' + body : ''}`);
      process.exit(0);
    }
    const refusal = tickRefusal(expr, doorErrorCode(text));
    log('ERROR', refusal ?? `tick: HTTP ${res.status} — is os:up running? ${body}`);
    process.exit(1);
  } catch (err) {
    log(
      'ERROR',
      `tick: fetch failed (${err.message}) — is os:up running on port ${CONFIG.ingestPort}?`,
    );
    process.exit(1);
  }
}

// os:up — full supervisor.
async function supervise({ exposeTowerToLan }) {
  runnerState.commit = codeCommit();
  log(
    'INFO',
    samePath(REPO_ROOT, HOME_ROOT)
      ? `starting NoticeOS local runner (repo: ${REPO_ROOT} · commit ${runnerState.commit?.slice(0, 8) ?? 'unknown'})`
      : `starting NoticeOS local runner from its runtime copy (code: ${REPO_ROOT} · commit ${
          runnerState.commit?.slice(0, 8) ?? 'unknown'
        } · state: ${HOME_ROOT})`,
  );
  log(
    'INFO',
    `port map — ingest door: ${CONFIG.ingestHost}:${CONFIG.ingestPort} (loopback only) · tower: ${
      exposeTowerToLan ? CONFIG.towerLanHost : '127.0.0.1'
    }:${CONFIG.towerPort} (${exposeTowerToLan ? 'network/explicit opt-in' : 'loopback/default'}) · one runtime serves both · beads hub: ${taskHubPortDescription()}`,
  );
  if (exposeTowerToLan) log('WARN', TOWER_NETWORK_NOTICE);

  // Single instance, decided before ANY of the work below: a runner that is
  // about to refuse must not spawn children that would lose the bind race.
  let ingestPortAnswers = await probeTcp(CONFIG.ingestHost, CONFIG.ingestPort);
  if (ingestPortAnswers && readProductEnv(process.env, 'managed') === '1') {
    const previous = await readPreviousRunnerState();
    if (await recoverManagedOrphan(previous)) ingestPortAnswers = false;
  }
  const instance = runnerArmDecision({ ingestPortAnswers }, CONFIG);
  log(instance.level, instance.text);
  if (!instance.arm) process.exit(EXIT_ALREADY_RUNNING);

  // A runner running from a runtime copy starts nothing until its copy is linked
  // to home's state and home's store exists (bead ro-ujb9.113).
  const copyRefusal = await runtimeCopyRefusal({ codeRoot: REPO_ROOT, homeRoot: HOME_ROOT });
  if (copyRefusal) {
    log('ERROR', copyRefusal);
    process.exit(EXIT_RUNTIME_COPY);
  }

  // The store's address, before anything starts (bead ro-ujb9.76.7.2):
  // DATABASE_URL from home's secrets file, checked as the application login,
  // then handed to the Tower child's environment and nowhere else. Checking
  // applies nothing: a database behind this code stops the start.
  const database = await runnerDatabase();
  if (!database.ok) {
    log('ERROR', `REFUSING to start: ${database.line}`);
    await closeLog();
    process.exit(EXIT_NO_DATABASE);
  }
  log('INFO', 'database: DATABASE_URL answers as the application login with every migration this code has');

  await writeRunnerState({
    pid: process.pid,
    startedAt: ts(),
    status: 'starting',
    managed: readProductEnv(process.env, 'managed') === '1',
    towerReady: false,
    towerPid: null,
    schedulerArmed: false,
  });

  const secretSync = await syncDevVarsIfPresent(SECRET_FILES);
  if (secretSync) {
    log(
      'INFO',
      `local secrets: compiled ${secretSync.keys.length} binding(s) from workers/ingest/.dev.secrets.json`,
    );
  }

  log(
    'INFO',
    'Postgres migrations are operator-only — startup applies none; use pnpm postgres:migrate while the OS is stopped',
  );

  const tower = towerChild({ exposeTowerToLan, database: database.env });

  const children = [tower];

  // Graceful shutdown: stop crons, group-kill children, escalate to SIGKILL.
  const shutdown = async (sig) => {
    if (isShuttingDown()) return;
    beginShutdown();
    log('INFO', `received ${sig} — shutting down`);
    stopScheduler();
    for (const c of children) killChild(c, 'SIGTERM');
    await waitForExit(children, 5000);
    for (const c of children) if (c.running) killChild(c, 'SIGKILL');
    await waitForExit(children, 2000);
    await writeRunnerState({
      status: 'stopped',
      towerReady: false,
      towerPid: null,
      schedulerArmed: false,
    });
    log('INFO', 'shutdown complete');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  for (const c of children) {
    if (!await startChild(c)) {
      await closeLog();
      process.exit(1);
    }
  }
  // force: say where the hub stands every startup, even when nothing changed.
  await checkBeadsHub({ force: true });
  // What the lanes did last time this machine was up — read before they arm, so
  // a restart answers "has the nightly backup been running?" without a scroll.
  const recorded = await reportJobRuns();
  // The store's copy of that record (db/0022): armed with what disk already
  // holds, so firings from before this process — or from while the store was
  // unreachable — reach `job_runs` on the first tick that finds the door open.
  const queued = armJobRunShipping(tower, recorded);
  log('INFO', `  job-run shipping → ${jobRunsUrl(CONFIG)} (${queued} record(s) queued to catch up)`);
  startDeployForwarding(tower);
  const scheduler = await startScheduler(tower, recorded, {
    lanes: hostLanes(tower),
    onPublished: (status) =>
      writeRunnerState({
        schedulerArmed: status.jobs.length > 0,
        status: tower.ready && status.jobs.length > 0 ? 'healthy' : 'starting',
      }),
  });

  await writeRunnerState({
    status: tower.ready && scheduler.snapshot().jobs.length > 0 ? 'healthy' : 'starting',
    towerReady: tower.ready,
    schedulerArmed: scheduler.snapshot().jobs.length > 0,
  });
  const heartbeat = setInterval(() => void writeRunnerState(), 30_000);
  trackTimer(heartbeat);
  // Which half of D21 this install is on, said once (bead `ro-vu8d.5`). After
  // the runtime is up, because the answer comes from the OS itself.
  void waitForRuntime(tower)
    .then(() => reportLegacyEnvCredentials(tower))
    .catch(() => {});
  // And which config this install is reading (epic `ro-syok`). Same posture as
  // the line above: after the runtime is up, from the OS's own answer, never
  // fatal.
  void waitForRuntime(tower)
    .then(() => reportConfigStore(tower))
    .catch(() => {});

  log('INFO', 'runner up — children supervised, scheduler armed. Ctrl-C to stop.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  await ensureDirs();
  await openLog();

  const argv = process.argv.slice(2);

  if (argv.includes('--tick')) {
    // `pnpm os:cron -- "0 * * * *"` forwards the `--` separator into argv, so
    // take the first arg after --tick that isn't the separator.
    const expr = argv
      .slice(argv.indexOf('--tick') + 1)
      .find((a) => a !== '--');
    if (!expr) {
      log('ERROR', 'os:cron needs a cron expression, e.g.  pnpm os:cron -- "0 * * * *"');
      process.exit(2);
    }
    await tickOnce(expr);
    return;
  }

  if (argv.includes('--backup')) {
    // Recorded like the scheduled one: a backup the operator ran by hand is
    // still the backup lane running, and leaving it out would make the record
    // claim a gap that never existed.
    const result = await runJobLane('backup', () => runBackup(), backupRunOutcome);
    process.exit(result?.ok === true ? 0 : 1);
  }

  let exposeTowerToLan;
  try {
    exposeTowerToLan = resolveTowerExposure(argv, process.env.OS_UP_HOST);
  } catch (error) {
    log('ERROR', error.message);
    process.exit(2);
  }
  await supervise({ exposeTowerToLan });
}

export const TOWER_NETWORK_NOTICE = 'Tower network access is enabled. Standalone has no login: anyone who can reach this port can read and change its data. Use an authenticated access tunnel or a trusted private network.';

/** Loopback is the default. Explicit CLI flags outrank OS_UP_HOST;
 * external access requires an affirmative, valid setting. */
export function resolveTowerExposure(argv, hostEnvValue) {
  if (argv.includes('--host') && argv.includes('--local')) {
    throw new Error('os:up accepts either --host or --local, not both');
  }
  if (argv.includes('--host')) return true;
  if (argv.includes('--local')) return false;
  const hostEnv = hostEnvValue?.trim().toLowerCase();
  if (hostEnv === undefined || hostEnv === '' || hostEnv === '0' || hostEnv === 'false') return false;
  if (hostEnv === '1' || hostEnv === 'true') return true;
  throw new Error('OS_UP_HOST must be true/1 or false/0; use --host for network access or --local for loopback');
}

// Through realpath: launchd runs this file through the runtime copy's `current`
// link, and a plain comparison with the link-resolved module URL says "not me".
if (invokedDirectly(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    // Last-resort guard: log and exit non-zero rather than an ugly stack trace.
    log('ERROR', `fatal: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
}
